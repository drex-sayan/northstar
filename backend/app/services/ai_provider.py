import os
import json
import logging
import re
import time
import warnings
from typing import Dict, Any, Optional, List

# Suppress noisy upstream Google SDK deprecation FutureWarnings
warnings.filterwarnings("ignore", category=FutureWarning, module=r"google\.(api_core|generativeai)")

from app.config import settings

logger = logging.getLogger("ai_provider")

class AIProviderService:
    """
    Robust Gemini AI Provider service with multi-model automatic fallback.
    Supported fallback priority:
      1. User configured model (if valid)
      2. gemini-2.5-flash
      3. gemini-2.0-flash
      4. gemini-1.5-flash
    Never raises unhandled exceptions on missing keys, 404, or 429 quota exhaustion.
    Returns None to allow downstream agents to run their deterministic fallbacks seamlessly.
    """

    CANDIDATE_MODELS = [
        "gemini-3.1-flash-lite",
        "gemini-3.8-flash",
        "gemini-3.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash"
    ]

    GROQ_CANDIDATE_MODELS = [
        "openai/gpt-oss-20b",
        "qwen/qwen3.8-27b",
        "openai/gpt-oss-120b"
    ]

    def __init__(self):
        self.api_key = ""
        self.groq_api_key = ""
        self._groq_cooldown_until = 0.0
        self._genai_client = None
        self._legacy_configured = False
        self._init_client()

    def _init_client(self):
        raw_key = settings.GEMINI_API_KEY or os.getenv("GOOGLE_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
        self.api_key = raw_key.strip().strip('"').strip("'") if raw_key else ""
        
        raw_groq = getattr(settings, "GROQ_API_KEY", "") or os.getenv("GROQ_API_KEY", "")
        self.groq_api_key = raw_groq.strip().strip('"').strip("'") if raw_groq else ""
        if not self.api_key or len(self.api_key) < 10:
            self._genai_client = None
            self._legacy_configured = False
            return

        # Attempt to init new google.genai
        try:
            from google import genai
            self._genai_client = genai.Client(api_key=self.api_key)
        except Exception:
            self._genai_client = None

        # Attempt to configure legacy google.generativeai as backup
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", category=FutureWarning)
                import google.generativeai as legacy_genai
                legacy_genai.configure(api_key=self.api_key)
            self._legacy_configured = True
        except Exception:
            self._legacy_configured = False

    def generate_json(self, prompt: str, system_instruction: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """
        Sends structured prompt to configured AI provider (Groq or Gemini) with multi-model fallback and JSON fence stripping.
        Returns parsed dict/list or None if unavailable/quota-limited.
        """
        current_env_groq_key = (getattr(settings, "GROQ_API_KEY", "") or os.getenv("GROQ_API_KEY", "")).strip().strip('"').strip("'")
        if not self.groq_api_key or self.groq_api_key != current_env_groq_key:
            self.groq_api_key = current_env_groq_key

        provider = (getattr(settings, "AI_PROVIDER", "") or os.getenv("AI_PROVIDER", "groq")).lower().strip()
        current_env_gemini_key = (settings.GEMINI_API_KEY or os.getenv("GOOGLE_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")).strip().strip('"').strip("'")
        if not self.api_key or self.api_key != current_env_gemini_key or not self._genai_client:
            self.api_key = current_env_gemini_key
            self._init_client()

        if provider == "groq" or (self.groq_api_key and not self.api_key):
            groq_res = self._generate_json_groq(prompt, system_instruction=system_instruction)
            if groq_res is not None:
                return groq_res
            # If Groq quota exhausted or failed, seamlessly fallback to Gemini if key available
            if not self.api_key or len(self.api_key) < 10:
                return None
            logger.info("Groq rate limit/exhaustion active. Seamlessly executing Gemini fallback...")

        if not self.api_key or len(self.api_key) < 10:
            logger.debug("Valid GEMINI_API_KEY is not configured; relying on deterministic agent logic.")
            return None

        # Build list of models to try in priority order
        models_to_try = []
        known_valid_prefixes = ("gemini-3", "gemini-2", "gemini-1")
        if settings.GEMINI_MODEL and any(settings.GEMINI_MODEL.startswith(p) for p in known_valid_prefixes):
            if settings.GEMINI_MODEL not in self.CANDIDATE_MODELS:
                models_to_try.append(settings.GEMINI_MODEL)
        models_to_try.extend(self.CANDIDATE_MODELS)

        combined_prompt = ""
        if system_instruction:
            combined_prompt += f"System Instruction:\n{system_instruction}\n\n"
        combined_prompt += f"{prompt}\n\nIMPORTANT: Respond with valid, parseable JSON only. Do NOT include commentary, markdown explanations, or preamble."

        for model_name in models_to_try:
            try:
                raw_text = self._call_gemini_model(model_name, combined_prompt)
                if not raw_text or not raw_text.strip():
                    continue

                # Strip markdown code fences
                clean_text = raw_text.strip()
                clean_text = re.sub(r"^```(?:json)?\s*", "", clean_text, flags=re.MULTILINE)
                clean_text = re.sub(r"\s*```$", "", clean_text, flags=re.MULTILINE)
                clean_text = clean_text.strip()

                # Extract JSON block if surrounded by extra conversational text
                match = re.search(r"(\{.*\}|\[.*\])", clean_text, re.DOTALL)
                if match:
                    clean_text = match.group(1).strip()

                parsed = json.loads(clean_text)
                if isinstance(parsed, (dict, list)):
                    return parsed
            except Exception as e:
                err_str = str(e).lower()
                if "429" in err_str or "quota" in err_str or "rate limit" in err_str:
                    logger.warning(f"Gemini model '{model_name}' quota limited (429). Attempting fallback...")
                elif "404" in err_str or "not found" in err_str:
                    logger.warning(f"Gemini model '{model_name}' not found (404). Attempting fallback...")
                else:
                    logger.warning(f"Gemini model '{model_name}' call failed: {e}")
                continue

        logger.warning("All Gemini candidate models failed or exhausted quota. Triggering deterministic fallback.")
        return None

    def _call_gemini_model(self, model_name: str, prompt: str) -> str:
        last_err = None
        # Try google.genai first
        if self._genai_client:
            try:
                resp = self._genai_client.models.generate_content(
                    model=model_name,
                    contents=prompt
                )
                if resp and resp.text:
                    return resp.text
            except Exception as e:
                last_err = e

        # Try legacy google.generativeai
        if self._legacy_configured:
            try:
                import google.generativeai as legacy_genai
                model = legacy_genai.GenerativeModel(model_name)
                resp = model.generate_content(prompt)
                if resp and resp.text:
                    return resp.text
            except Exception as e:
                last_err = e

        if last_err:
            raise last_err
        return ""

    def _generate_json_groq(self, prompt: str, system_instruction: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """
        Sends structured prompt to Groq API with multi-model fallback and JSON parsing.
        """
        if time.time() < self._groq_cooldown_until:
            logger.debug(f"Groq is in rate-limit cooldown for another {int(self._groq_cooldown_until - time.time())}s. Routing to Gemini fallback.")
            return None

        if not self.groq_api_key or len(self.groq_api_key) < 10:
            logger.debug("Valid GROQ_API_KEY is not configured; relying on deterministic agent logic.")
            return None

        # Build list of Groq models to try
        models_to_try = []
        configured_model = (getattr(settings, "GROQ_MODEL", "") or os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")).strip()
        if configured_model:
            models_to_try.append(configured_model)
        for m in self.GROQ_CANDIDATE_MODELS:
            if m not in models_to_try:
                models_to_try.append(m)

        for model_name in models_to_try:
            if time.time() < self._groq_cooldown_until:
                break
            try:
                raw_text = self._call_groq_model(model_name, prompt, system_instruction=system_instruction)
                if not raw_text or not raw_text.strip():
                    continue

                # Strip markdown code fences
                clean_text = raw_text.strip()
                clean_text = re.sub(r"^```(?:json)?\s*", "", clean_text, flags=re.MULTILINE)
                clean_text = re.sub(r"\s*```$", "", clean_text, flags=re.MULTILINE)
                clean_text = clean_text.strip()

                # Extract JSON block if surrounded by extra conversational text
                match = re.search(r"(\{.*\}|\[.*\])", clean_text, re.DOTALL)
                if match:
                    clean_text = match.group(1).strip()

                parsed = json.loads(clean_text)
                if isinstance(parsed, (dict, list)):
                    return parsed
            except Exception as e:
                err_str = str(e).lower()
                if "429" in err_str or "quota" in err_str or "rate limit" in err_str:
                    logger.warning(f"Groq model '{model_name}' quota limited (429). Activating cooldown and switching to Gemini fallback.")
                    self._groq_cooldown_until = time.time() + 60.0
                    break
                elif "404" in err_str or "not found" in err_str or "model_not_found" in err_str:
                    logger.warning(f"Groq model '{model_name}' not found (404). Attempting fallback...")
                else:
                    logger.warning(f"Groq model '{model_name}' call failed: {e}")
                continue

        logger.warning("Groq unavailable or exhausted quota. Triggering fallback.")
        return None

    def _call_groq_model(self, model_name: str, prompt: str, system_instruction: Optional[str] = None) -> str:
        """
        Executes HTTP POST request to Groq OpenAI-compatible chat completions endpoint.
        """
        import httpx

        api_key = self.groq_api_key or (getattr(settings, "GROQ_API_KEY", "") or os.getenv("GROQ_API_KEY", "")).strip().strip('"').strip("'")
        if not api_key:
            return ""

        base_url = (getattr(settings, "GROQ_BASE_URL", "") or os.getenv("GROQ_BASE_URL", "") or "https://api.groq.com/openai/v1").rstrip("/")
        url = f"{base_url}/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        messages = []
        if system_instruction:
            messages.append({"role": "system", "content": f"{system_instruction}\nRespond in valid JSON only."})
        else:
            messages.append({"role": "system", "content": "You are a professional narrative intelligence assistant. Always respond in valid JSON."})
        messages.append({"role": "user", "content": f"{prompt}\n\nIMPORTANT: Respond with valid, parseable JSON only."})

        payload = {
            "model": model_name,
            "messages": messages,
            "temperature": 0.2,
            "response_format": {"type": "json_object"}
        }

        with httpx.Client(timeout=30.0) as client:
            resp = client.post(url, headers=headers, json=payload)
            if resp.status_code == 429:
                self._groq_cooldown_until = time.time() + 60.0
                logger.warning(f"Groq model '{model_name}' hit rate limit (429). Activating 60s cooldown and falling back immediately.")
                return ""
            if resp.status_code == 400 and ("response_format" in resp.text.lower() or "json" in resp.text.lower()):
                payload.pop("response_format", None)
                resp = client.post(url, headers=headers, json=payload)

            if resp is not None:
                resp.raise_for_status()
                data = resp.json()
                choices = data.get("choices", [])
                if choices and "message" in choices[0]:
                    return choices[0]["message"].get("content", "")
        return ""

ai_provider = AIProviderService()
