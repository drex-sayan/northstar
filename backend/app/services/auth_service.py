import re
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import bcrypt
from jose import jwt, JWTError
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.database import models

logger = logging.getLogger("auth_service")

EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")

class AuthService:
    @staticmethod
    def hash_password(password: str) -> str:
        """Hash a plaintext password securely using bcrypt."""
        if not password:
            raise ValueError("Password cannot be empty")
        salt = bcrypt.gensalt(rounds=12)
        hashed = bcrypt.hashpw(password.encode("utf-8"), salt)
        return hashed.decode("utf-8")

    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        """Verify plaintext password against bcrypt hash."""
        if not plain_password or not hashed_password:
            return False
        try:
            return bcrypt.checkpw(
                plain_password.encode("utf-8"),
                hashed_password.encode("utf-8")
            )
        except Exception:
            return False

    @staticmethod
    def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
        """Create a signed JWT token."""
        to_encode = data.copy()
        if expires_delta:
            expire = datetime.utcnow() + expires_delta
        else:
            expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        
        to_encode.update({"exp": expire, "iat": datetime.utcnow()})
        encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
        return encoded_jwt

    @staticmethod
    def decode_access_token(token: str) -> Optional[Dict[str, Any]]:
        """Decode and validate a signed JWT token."""
        try:
            payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
            return payload
        except JWTError:
            return None

    @staticmethod
    def validate_email(email: str) -> bool:
        """Check valid email format."""
        if not email or len(email) > 255:
            return False
        return bool(EMAIL_REGEX.match(email.strip()))

    @classmethod
    def _heal_users_table(cls, db: Session):
        """Self-healing: Ensures all required columns exist on the users table in database."""
        try:
            db.rollback()
        except Exception:
            pass

        try:
            from sqlalchemy import inspect
            insp = inspect(db.get_bind())
            existing_cols = {c["name"] for c in insp.get_columns("users")}
        except Exception:
            existing_cols = set()

        columns_needed = [
            ("full_name", "VARCHAR(255)"),
            ("is_active", "BOOLEAN DEFAULT TRUE"),
            ("is_superuser", "BOOLEAN DEFAULT FALSE"),
            ("created_at", "TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP"),
            ("updated_at", "TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP")
        ]

        # Only execute ALTER TABLE if a column is genuinely missing
        missing = [col for col, _ in columns_needed if col not in existing_cols]
        if not missing and existing_cols:
            return

        for col_name, col_type in columns_needed:
            if col_name not in existing_cols:
                stmt = f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col_name} {col_type};"
                try:
                    db.execute(text(stmt))
                    db.commit()
                except Exception as ex:
                    try:
                        db.rollback()
                    except Exception:
                        pass
                    logger.warning(f"[Auth Healing Note] {stmt} -> {ex}")
        logger.info("[Auth Service] Self-healed users table missing columns successfully.")

    @classmethod
    def get_user_by_email(cls, db: Session, email: str) -> Optional[models.User]:
        """Fetch user by case-insensitive email with automatic schema self-healing."""
        if not email:
            return None
        clean_email = email.strip()
        try:
            return db.query(models.User).filter(models.User.email.ilike(clean_email)).first()
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            err_str = str(e).lower()
            if "lock" in err_str or "timeout" in err_str:
                logger.warning(f"[AuthService] Query lock/timeout on users table: {e}")
                raise e
            if any(term in err_str for term in ["undefinedcolumn", "no such column"]):
                logger.warning(f"[AuthService] Detected missing column on users table query ({e}). Self-healing...")
                cls._heal_users_table(db)
                try:
                    return db.query(models.User).filter(models.User.email.ilike(clean_email)).first()
                except Exception:
                    return None
            raise e

    @classmethod
    def get_user_by_id(cls, db: Session, user_id: str) -> Optional[models.User]:
        """Fetch user by unique ID with automatic schema self-healing."""
        if not user_id:
            return None
        uid_str = str(user_id)
        try:
            return db.query(models.User).filter(models.User.id == uid_str).first()
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            err_str = str(e).lower()
            if "lock" in err_str or "timeout" in err_str:
                logger.warning(f"[AuthService] Query lock/timeout on users table: {e}")
                raise e
            if any(term in err_str for term in ["undefinedcolumn", "no such column"]):
                logger.warning(f"[AuthService] Detected missing column on users table query ({e}). Self-healing...")
                cls._heal_users_table(db)
                try:
                    return db.query(models.User).filter(models.User.id == uid_str).first()
                except Exception:
                    return None
            raise e

    @classmethod
    def register_user(
        cls,
        db: Session,
        email: str,
        password: str,
        confirm_password: Optional[str] = None,
        full_name: Optional[str] = None
    ) -> models.User:
        """Register a new user with validation and bcrypt hashing."""
        email_clean = email.strip().lower() if email else ""
        if not cls.validate_email(email_clean):
            raise ValueError("Invalid email address format.")
        
        if not password or len(password) < 6:
            raise ValueError("Password must be at least 6 characters long.")
        
        if confirm_password is not None and password != confirm_password:
            raise ValueError("Password and confirm password do not match.")

        existing = cls.get_user_by_email(db, email_clean)
        if existing:
            raise ValueError("An account with this email address already exists.")

        hashed = cls.hash_password(password)
        new_user = models.User(
            id=models.gen_uuid(),
            email=email_clean,
            hashed_password=hashed,
            full_name=full_name.strip() if full_name else (email_clean.split("@")[0] or "User"),
            is_active=True,
            is_superuser=False
        )
        try:
            db.add(new_user)
            db.commit()
            db.refresh(new_user)
        except Exception as e:
            err_str = str(e).lower()
            if any(term in err_str for term in ["is_superuser", "undefinedcolumn", "no such column", "users."]):
                logger.warning(f"[AuthService] Detected missing column during user registration ({e}). Self-healing...")
                cls._heal_users_table(db)
                db.add(new_user)
                db.commit()
                db.refresh(new_user)
            else:
                db.rollback()
                raise e
        return new_user

    @classmethod
    def authenticate_user(cls, db: Session, email: str, password: str) -> Optional[models.User]:
        """Verify user credentials and return user model."""
        if not email or not password:
            return None
        user = cls.get_user_by_email(db, email)
        if not user:
            return None
        if not cls.verify_password(password, user.hashed_password):
            return None
        return user

    @classmethod
    def is_guest_user(cls, user: Optional[models.User]) -> bool:
        """Determines if a user account is an ephemeral one-time guest account."""
        if not user or not user.email:
            return False
        clean_email = user.email.strip().lower()
        return clean_email.startswith("guest_") or clean_email.startswith("guest.") or clean_email == "guest.author@storybible.ai"

    @classmethod
    def create_guest_user(cls, db: Session) -> models.User:
        """Create a unique one-time ephemeral guest user for instant frictionless testing."""
        guest_id = models.gen_uuid()
        short_id = guest_id.replace("-", "")[:8]
        guest_email = f"guest_{short_id}@storybible.ai"

        user = models.User(
            id=guest_id,
            email=guest_email,
            hashed_password=cls.hash_password("GuestDemoPassword123!"),
            full_name="Guest Author",
            is_active=True,
            is_superuser=False
        )
        try:
            db.add(user)
            db.commit()
            db.refresh(user)
        except Exception as e:
            err_str = str(e).lower()
            if any(term in err_str for term in ["is_superuser", "undefinedcolumn", "no such column", "users."]):
                logger.warning(f"[AuthService] Detected missing column during guest user creation ({e}). Self-healing...")
                cls._heal_users_table(db)
                db.add(user)
                db.commit()
                db.refresh(user)
            else:
                db.rollback()
                raise e
        return user

    @classmethod
    def get_or_create_guest_user(cls, db: Session) -> models.User:
        """Backwards-compatible alias for creating a one-time guest user."""
        return cls.create_guest_user(db)

    @classmethod
    def cleanup_guest_user(cls, db: Session, user: models.User):
        """
        Permanently deletes a one-time guest author session and all work created by them.
        Deletes vector embeddings, projects, chapters, entities, manuscripts, and the guest account itself.
        """
        if not user or not cls.is_guest_user(user):
            return

        user_id_str = str(user.id)
        try:
            # Query all projects owned by this guest
            guest_projects = db.query(models.Project).filter(models.Project.user_id == user.id).all()
            from app.services.vector_service import vector_service

            for proj in guest_projects:
                proj_id_str = str(proj.id)
                try:
                    vector_service.clear_project(proj_id_str)
                except Exception as ex:
                    logger.warning(f"[GuestCleanup] Error clearing vector store for project {proj_id_str}: {ex}")
                db.delete(proj)

            # Delete project memberships
            db.query(models.ProjectMember).filter(models.ProjectMember.user_id == user.id).delete(synchronize_session=False)

            # Delete the guest user record
            db.delete(user)
            db.commit()
            logger.info(f"[GuestCleanup] Successfully deleted one-time guest user {user.email} (ID: {user_id_str}) and purged all project data.")
        except Exception as e:
            db.rollback()
            logger.error(f"[GuestCleanup] Failed to clean up guest user data ({user_id_str}): {e}")

auth_service = AuthService()
