import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ShieldCheck,
  AlertTriangle,
  Sparkles,
  BookOpen,
  CheckCircle,
  HelpCircle,
  ChevronRight,
  Filter,
  RefreshCw,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  FileText,
  Minimize2,
  Maximize2,
  RotateCcw,
  Layout,
  GitMerge,
  Compass,
  GitFork,
  X,
  ExternalLink
} from 'lucide-react';
import Navbar from '../components/Navbar';
import Sidebar from '../components/Sidebar';
import Editor from '../components/Editor';
import IssueCard from '../components/IssueCard';
import EntityMatchingDrawer from '../components/EntityMatchingDrawer';
import { useToast } from '../context/ToastContext';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { projectService, chapterService, architectService, getCached, subscribeProjectEvents } from '../services/api';

const PANELS_STORAGE_KEY = 'northstar_workspace_panels';

// Helper to load persisted panel states from localStorage
const getSavedPanelState = () => {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  try {
    const saved = localStorage.getItem(PANELS_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        left: isMobile ? false : (typeof parsed.left === 'boolean' ? parsed.left : true),
        center: typeof parsed.center === 'boolean' ? parsed.center : true,
        right: isMobile ? false : (typeof parsed.right === 'boolean' ? parsed.right : true),
      };
    }
  } catch (e) {
    console.warn('Failed to parse saved panel state:', e);
  }
  return { left: !isMobile, center: true, right: !isMobile };
};

export default function Workspace() {
  const { projectId } = useParams();
  const toast = useToast();

  const cachedBundle = getCached(`project:bundle:${projectId}`);
  const cachedProj = getCached(`project:${projectId}`) || cachedBundle?.project;
  const cachedChaps = getCached(`chapters:${projectId}`) || cachedBundle?.chapters;
  const cachedIssues = getCached(`issues:${projectId}:{}`) || cachedBundle?.issues;

  const [project, setProject] = useState(() => cachedProj || null);
  useDocumentTitle(project?.name ? `${project.name} | Manuscript Workspace` : 'Manuscript Workspace');
  const [chapters, setChapters] = useState(() => Array.isArray(cachedChaps) ? cachedChaps : []);
  const [selectedChapterId, setSelectedChapterId] = useState(() => cachedChaps?.[0]?.id || null);
  const [currentChapter, setCurrentChapter] = useState(() => cachedChaps?.[0] || null);
  const [issues, setIssues] = useState(() => Array.isArray(cachedIssues) ? cachedIssues : []);
  const [loading, setLoading] = useState(() => !cachedProj && !cachedBundle);
  const [analyzing, setAnalyzing] = useState(false);
  const [issueFilter, setIssueFilter] = useState('all'); // all, unresolved, current_chapter
  const [matchingCandidatesCount, setMatchingCandidatesCount] = useState(0);
  const [showMatchingDrawer, setShowMatchingDrawer] = useState(false);
  const [showWorldGraphDrawer, setShowWorldGraphDrawer] = useState(false);
  const [graphData, setGraphData] = useState(null);

  // Panel Collapsible Visibility State & Persistence
  const initialPanels = getSavedPanelState();
  const [isLeftOpen, setIsLeftOpen] = useState(initialPanels.left);
  const [isCenterOpen, setIsCenterOpen] = useState(initialPanels.center);
  const [isRightOpen, setIsRightOpen] = useState(initialPanels.right);

  // Sync panel states to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem(
        PANELS_STORAGE_KEY,
        JSON.stringify({ left: isLeftOpen, center: isCenterOpen, right: isRightOpen })
      );
    } catch (e) {
      console.warn('Failed to persist panel state:', e);
    }
  }, [isLeftOpen, isCenterOpen, isRightOpen]);

  // Load project details and chapters using the fast bundle endpoint (1 roundtrip)
  const loadWorkspaceData = async () => {
    try {
      if (!project) setLoading(true);
      // Fetch combined bundle in a single network roundtrip
      try {
        const bundle = await projectService.getProjectBundle(projectId);
        if (bundle && bundle.project) {
          setProject(bundle.project);
          const safeChaps = Array.isArray(bundle.chapters) ? bundle.chapters : [];
          setChapters(safeChaps);
          setIssues(Array.isArray(bundle.issues) ? bundle.issues : []);

          if (safeChaps.length > 0) {
            const activeId = selectedChapterId || safeChaps[0].id;
            setSelectedChapterId(activeId);
            const found = safeChaps.find((c) => c.id === activeId) || safeChaps[0];
            setCurrentChapter(found);
          }
          return;
        }
      } catch (e) {
        // Fallback to parallel requests if bundle route is unavailable
      }

      const [proj, chaps, projIssues] = await Promise.all([
        projectService.getProject(projectId),
        chapterService.getChapters(projectId),
        projectService.getIssues(projectId),
      ]);

      setProject(proj);
      const safeChaps = Array.isArray(chaps) ? chaps : [];
      setChapters(safeChaps);
      setIssues(Array.isArray(projIssues) ? projIssues : []);

      if (safeChaps.length > 0) {
        const targetId = selectedChapterId || safeChaps[0].id;
        setSelectedChapterId(targetId);
        const chData = await chapterService.getChapter(targetId);
        setCurrentChapter(chData);
      }

      // Check for pending matching candidates in background
      architectService.getMatchingCandidates(projectId).then((m) => {
        setMatchingCandidatesCount(m?.length || 0);
      }).catch(() => {});
    } catch (err) {
      console.error('Failed to load workspace data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      loadWorkspaceData();
    }
  }, [projectId]);

  // Progressive real-time updates via Server-Sent Events (SSE)
  useEffect(() => {
    if (!projectId) return;

    const unsubscribe = subscribeProjectEvents(projectId, (event) => {
      if (!event || !event.type) return;

      if (event.type === 'chapter:completed') {
        chapterService.getChapters(projectId, { forceRefresh: true }).then((updatedChaps) => {
          if (Array.isArray(updatedChaps) && updatedChaps.length > 0) {
            setChapters(updatedChaps);
          }
        }).catch(() => {});
      } else if (event.type === 'continuity:issues_found') {
        const newIssues = event.data?.issues || [];
        if (newIssues.length > 0) {
          setIssues((prev) => {
            const existingIds = new Set((prev || []).map((i) => i.id));
            const fresh = newIssues.filter((i) => !existingIds.has(i.id));
            return fresh.length > 0 ? [...fresh, ...prev] : prev;
          });
        }
      } else if (event.type === 'job:completed') {
        toast.success(event.data?.message || 'Narrative intelligence analysis complete.');
        projectService.getIssues(projectId, {}, { forceRefresh: true }).then((finalIssues) => {
          if (Array.isArray(finalIssues)) setIssues(finalIssues);
        }).catch(() => {});
      }
    });

    return () => {
      unsubscribe();
    };
  }, [projectId]);

  // Handle chapter selection
  const handleSelectChapter = async (chapId) => {
    setSelectedChapterId(chapId);
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setIsLeftOpen(false);
    }
    try {
      const chData = await chapterService.getChapter(chapId);
      setCurrentChapter(chData);
    } catch (err) {
      console.error('Failed to switch chapter:', err);
    }
  };

  // Handle adding new chapter
  const handleAddChapter = async (newChapData) => {
    try {
      const created = await chapterService.createChapter(projectId, newChapData);
      setChapters([...chapters, created]);
      setSelectedChapterId(created.id);
      setCurrentChapter(created);
      toast.success(`Chapter "${created.title || 'New Chapter'}" created`);
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        setIsLeftOpen(false);
      }
    } catch (err) {
      console.error('Failed to add chapter:', err);
      toast.error('Failed to add chapter');
    }
  };

  // Handle editor save
  const handleSaveEditor = async (htmlContent, plainContent) => {
    if (!currentChapter) return;
    try {
      const updated = await chapterService.updateChapter(currentChapter.id, {
        content: plainContent,
      });
      setCurrentChapter((prev) =>
        prev
          ? {
              ...prev,
              content: plainContent,
              word_count: updated?.word_count ?? plainContent.trim().split(/\s+/).filter(Boolean).length,
            }
          : prev
      );
      // Refresh chapter list for word count
      const updatedChaps = await chapterService.getChapters(projectId, { forceRefresh: true });
      if (Array.isArray(updatedChaps)) {
        setChapters(updatedChaps);
      }
      toast.success('Chapter saved to encrypted vault');
    } catch (err) {
      console.error('Failed to save chapter:', err);
      toast.error('Failed to save chapter');
    }
  };

  // Handle live Continuity Guardian analysis
  const handleAnalyzeChapter = async (liveEditorText) => {
    if (!currentChapter) return;
    try {
      setAnalyzing(true);
      // Auto-open Right Guardian Panel so author immediately sees the scanning progress and results
      setIsRightOpen(true);

      const contentToAnalyze =
        typeof liveEditorText === 'string' && liveEditorText.trim().length > 0
          ? liveEditorText
          : currentChapter.content;

      // Keep currentChapter state synchronized with the latest prose being analyzed
      setCurrentChapter((prev) =>
        prev
          ? {
              ...prev,
              content: contentToAnalyze,
              word_count: contentToAnalyze.trim().split(/\s+/).filter(Boolean).length,
            }
          : prev
      );

      const res = await chapterService.analyzeChapter(
        currentChapter.id,
        contentToAnalyze,
        projectId
      );

      // Always update issues state when an array is returned
      if (res && Array.isArray(res.issues)) {
        setIssues(res.issues);
        if (res.issues.length > 0) {
          toast.warning(`Continuity audit: ${res.issues.length} potential contradiction(s) found`);
        } else {
          toast.success('Continuity audit passed: No contradictions detected');
        }
      } else {
        toast.success('Continuity audit complete');
      }

      setIssueFilter('all');

      try {
        const projIssues = await projectService.getIssues(projectId, {}, { forceRefresh: true });
        if (Array.isArray(projIssues)) {
          setIssues(projIssues);
        }
      } catch (silentErr) {
        console.warn('Silent issues refresh skipped:', silentErr);
      }

      projectService.getProject(projectId, { forceRefresh: true }).then(setProject).catch(console.error);
      chapterService.getChapters(projectId, { forceRefresh: true }).then((chaps) => {
        if (Array.isArray(chaps)) setChapters(chaps);
      }).catch(console.error);
    } catch (err) {
      console.error('Failed to analyze chapter:', err);
      toast.error(err.message || 'Continuity audit failed');
    } finally {
      setAnalyzing(false);
    }
  };

  // Handle project-wide live Continuity Guardian scan
  const handleRunContinuityScan = async () => {
    try {
      setAnalyzing(true);
      setIsRightOpen(true);
      const res = await projectService.analyzeContinuity(projectId);
      if (res && Array.isArray(res.issues)) {
        setIssues(res.issues);
        if (res.issues.length > 0) {
          toast.warning(`Continuity audit: ${res.issues.length} potential contradiction(s) found across manuscript`);
        } else {
          toast.success('Continuity audit passed: No contradictions detected across manuscript');
        }
      }
      setIssueFilter('all');
      projectService.getProject(projectId, { forceRefresh: true }).then(setProject).catch(console.error);
    } catch (err) {
      console.warn('Project continuity scan fallback to chapter audit:', err);
      await handleAnalyzeChapter();
    } finally {
      setAnalyzing(false);
    }
  };

  // Status update on an issue
  const handleStatusUpdate = (updatedIssue) => {
    setIssues(issues.map((i) => (i.id === updatedIssue.id ? updatedIssue : i)));
    projectService.getProject(projectId).then(setProject);
  };

  // Count unresolved issues for live indicator badge
  const unresolvedCount = issues.filter(
    (i) => i.status === 'unresolved' || i.status === 'open'
  ).length;

  // Filter issues for current view
  const currentChapterIssues = issues.filter((i) => {
    const chNum = currentChapter?.chapter_number;
    return (
      i.chapter_id === selectedChapterId ||
      i.new_chapter_number === chNum ||
      i.earlier_chapter_number === chNum ||
      (Array.isArray(i.evidence) && i.evidence.some((ev) => ev.chapter === chNum))
    );
  });

  const displayedIssues = issues.filter((i) => {
    if (issueFilter === 'unresolved') return i.status === 'unresolved' || i.status === 'open';
    if (issueFilter === 'high') return (i.severity || '').toLowerCase() === 'high';
    if (issueFilter === 'current_chapter') {
      const chNum = currentChapter?.chapter_number;
      return (
        i.chapter_id === selectedChapterId ||
        i.new_chapter_number === chNum ||
        i.earlier_chapter_number === chNum ||
        (Array.isArray(i.evidence) && i.evidence.some((ev) => ev.chapter === chNum))
      );
    }
    return true;
  });

  if (loading && !project) {
    return (
      <div className="h-screen flex flex-col bg-[#f6f6f4] dark:bg-[#161618] overflow-hidden transition-colors duration-200">
        <Navbar currentProject={null} />
        <div className="flex-1 flex overflow-hidden animate-pulse graphite-grid-bg">
          {/* Column 1 Skeleton: Sidebar */}
          <div className="w-64 bg-[#fcfcfb] dark:bg-[#1c1c1e] border-r border-[#1c1c1e]/10 dark:border-white/10 p-4 space-y-3 shrink-0">
            <div className="h-4 bg-[#1c1c1e]/10 dark:bg-white/10 rounded-md w-3/4 mb-4" />
            <div className="h-8 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-lg w-full" />
            <div className="h-8 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-lg w-full" />
            <div className="h-8 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-lg w-full" />
            <div className="h-8 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-lg w-full" />
          </div>
          {/* Column 2 Skeleton: Editor */}
          <div className="flex-1 p-4 flex flex-col space-y-4">
            <div className="bg-[#fcfcfb] dark:bg-[#1c1c1e] rounded-xl border border-[#1c1c1e]/10 dark:border-white/10 p-6 flex-1 space-y-4">
              <div className="h-7 bg-[#1c1c1e]/10 dark:bg-white/10 rounded-md w-1/3" />
              <div className="h-8 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-lg w-full" />
              <div className="space-y-2.5 pt-4">
                <div className="h-4 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-md w-full" />
                <div className="h-4 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-md w-11/12" />
                <div className="h-4 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-md w-4/5" />
                <div className="h-4 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-md w-full" />
              </div>
            </div>
          </div>
          {/* Column 3 Skeleton: Guardian Panel */}
          <div className="w-80 lg:w-96 bg-[#fcfcfb] dark:bg-[#1c1c1e] border-l border-[#1c1c1e]/10 dark:border-white/10 p-4 space-y-4 shrink-0">
            <div className="flex items-center space-x-2 pb-3 border-b border-[#1c1c1e]/10 dark:border-white/10">
              <div className="w-6 h-6 rounded-md bg-[#1c1c1e]/10 dark:bg-white/10" />
              <div className="h-4 bg-[#1c1c1e]/10 dark:bg-white/10 rounded-md w-36" />
            </div>
            <div className="h-32 bg-[#1c1c1e]/5 dark:bg-white/5 rounded-xl border border-[#1c1c1e]/10 dark:border-white/10 p-4 space-y-2" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#f6f6f4] dark:bg-[#161618] text-[#1c1c1e] dark:text-[#f5f5f7] overflow-hidden font-sans transition-colors duration-200">
      <Navbar currentProject={project} />

      {/* 3-Column Workspace Layout */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile Backdrop for Left Chapter Drawer */}
        {isLeftOpen && (
          <div
            onClick={() => setIsLeftOpen(false)}
            className="md:hidden fixed inset-0 bg-black/40 backdrop-blur-xs z-40 transition-opacity"
          />
        )}

        {/* COLUMN 1: LEFT CHAPTER TREE & OUTLINE */}
        <div
          className={`h-full transition-all duration-300 ease-in-out flex flex-col shrink-0 ${
            'fixed md:relative inset-y-0 left-0 z-50 md:z-auto bg-[#fcfcfb] dark:bg-[#1c1c1e] shadow-2xl md:shadow-none'
          } ${
            isLeftOpen
              ? 'w-72 sm:w-80 md:w-64 lg:w-72 translate-x-0 opacity-100'
              : '-translate-x-full md:translate-x-0 md:w-0 md:min-w-0 md:opacity-0 md:pointer-events-none md:overflow-hidden'
          }`}
        >
          <div className="w-full h-full flex flex-col">
            <Sidebar
              chapters={chapters}
              selectedChapterId={selectedChapterId}
              onSelectChapter={handleSelectChapter}
              onAddChapter={handleAddChapter}
              projectName={project?.name}
              onClose={() => setIsLeftOpen(false)}
            />
          </div>
        </div>

        {/* Collapsed Left Edge Slider Handle - DESKTOP ONLY */}
        {!isLeftOpen && (
          <button
            onClick={() => setIsLeftOpen(true)}
            title={`Expand Manuscript Panel (${chapters.length} chapters)`}
            className="hidden md:flex group relative flex flex-col items-center justify-start pt-3 w-8 shrink-0 h-full bg-[#fcfcfb] dark:bg-[#1c1c1e] hover:bg-[#f6f6f4] dark:hover:bg-[#222224] border-r border-[#1c1c1e]/10 dark:border-white/10 text-[#636366] dark:text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-[#f5f5f7] transition-all select-none cursor-pointer z-10 shadow-2xs"
          >
            <div className="w-6 h-6 rounded-md flex items-center justify-center text-[#8e8e93] group-hover:text-[#1c1c1e] dark:group-hover:text-white transition-colors mb-3">
              <PanelLeftOpen className="w-3.5 h-3.5" />
            </div>
            <div
              className="flex items-center justify-center space-x-1 text-[10px] font-mono-cap tracking-wider uppercase text-[#8e8e93] group-hover:text-[#1c1c1e] dark:group-hover:text-white transition-colors select-none mt-2"
              style={{ writingMode: 'vertical-rl' }}
            >
              <span className="rotate-180">Chapters ({chapters.length})</span>
            </div>
          </button>
        )}

        {/* ========================================================= */}
        {/* COLUMN 2: CENTRE TIPTAP WRITING CANVAS */}
        {/* ========================================================= */}
        <section
          className={`h-full transition-all duration-300 ease-in-out flex flex-col overflow-hidden relative ${
            isCenterOpen
              ? 'flex-1 min-w-0 opacity-100 p-0 sm:p-3 md:p-4'
              : 'w-0 flex-none min-w-0 opacity-0 pointer-events-none p-0 overflow-hidden'
          }`}
        >
          {/* Mobile Quick Action Strip (Toggles for Chapters & Guardian) */}
          <div className="md:hidden flex items-center justify-between px-3 py-2 bg-[#fcfcfb] dark:bg-[#1c1c1e] border-b border-[#1c1c1e]/10 dark:border-white/10 gap-2 shrink-0">
            <button
              onClick={() => setIsLeftOpen(true)}
              className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border border-[#1c1c1e]/10 dark:border-white/10 bg-[#f6f6f4] dark:bg-[#222224] text-xs font-medium text-[#1c1c1e] dark:text-[#f5f5f7] shadow-2xs cursor-pointer truncate max-w-[55%]"
            >
              <PanelLeft className="w-3.5 h-3.5 text-[#8e8e93] shrink-0" />
              <span className="truncate">{currentChapter?.title || 'Chapters'}</span>
              <span className="text-[10px] text-[#8e8e93] font-mono shrink-0">({chapters.length})</span>
            </button>

            <button
              onClick={() => setIsRightOpen(true)}
              className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium shadow-2xs cursor-pointer shrink-0 ${
                unresolvedCount > 0
                  ? 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300'
                  : 'bg-[#f6f6f4] dark:bg-[#222224] border-[#1c1c1e]/10 dark:border-white/10 text-[#1c1c1e] dark:text-[#f5f5f7]'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              <span>AI Guardian</span>
              {unresolvedCount > 0 && (
                <span className="px-1.5 py-0.2 text-[9px] font-bold rounded-full bg-amber-500 text-white shrink-0">
                  {unresolvedCount}
                </span>
              )}
            </button>
          </div>
          {/* Entity Matching Queue Alert Banner */}
          {matchingCandidatesCount > 0 && (
            <div className="mb-3 px-4 py-2.5 bg-[#fcfcfb] dark:bg-[#1c1c1e] border border-[#1c1c1e]/10 dark:border-white/10 rounded-xl flex items-center justify-between text-xs text-[#1c1c1e] dark:text-[#f5f5f7] shadow-2xs">
              <div className="flex items-center space-x-2">
                <GitMerge className="w-4 h-4 text-[#8e8e93] shrink-0" />
                <span>
                  <strong>{matchingCandidatesCount} entity match candidate{matchingCandidatesCount > 1 ? 's' : ''}</strong> require author reconciliation.
                </span>
              </div>
              <button
                onClick={() => setShowMatchingDrawer(true)}
                className="btn btn-solid btn-sm text-[11.5px]"
              >
                Review &amp; Reconcile
              </button>
            </div>
          )}

          {currentChapter ? (
            <div className="flex-1 flex flex-col relative overflow-hidden">
              <Editor
                initialContent={currentChapter.content}
                chapterTitle={currentChapter.title}
                onSave={handleSaveEditor}
                onAnalyze={handleRunContinuityScan}
                analyzing={analyzing}
                onCollapse={() => setIsCenterOpen(false)}
              />

              {/* Floating Quick World Graph Button */}
              <div className="absolute bottom-4 right-4 z-20 flex items-center space-x-2">
                <button
                  onClick={() => {
                    setShowWorldGraphDrawer(true);
                    if (!graphData) {
                      projectService.getGraph(projectId).then(setGraphData).catch(console.error);
                    }
                  }}
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-[#fcfcfb]/95 dark:bg-[#1c1c1e]/95 backdrop-blur-xs border border-[#1c1c1e]/15 dark:border-white/15 rounded-full shadow-xs text-xs font-medium text-[#1c1c1e] dark:text-[#f5f5f7] hover:border-[#1c1c1e]/30 dark:hover:border-white/30 transition-all cursor-pointer"
                  title="Inspect World Graph without leaving editor"
                >
                  <GitFork className="w-3.5 h-3.5 text-[#8e8e93]" />
                  <span>Quick World Lore</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center bg-[#fcfcfb] dark:bg-[#1c1c1e] graphite-grid-bg rounded-xl border border-[#1c1c1e]/10 dark:border-white/10 text-center p-8 shadow-2xs relative overflow-hidden">
              <div className="relative z-10 max-w-sm p-6 bg-[#fcfcfb]/95 dark:bg-[#1c1c1e]/95 backdrop-blur-xs rounded-xl border border-[#1c1c1e]/10 dark:border-white/10 shadow-xs">
                <BookOpen className="w-8 h-8 text-[#8e8e93] mx-auto mb-3 stroke-1" />
                <h4 className="text-xs font-semibold text-[#1c1c1e] dark:text-[#f5f5f7] mb-1">
                  No Chapter Selected
                </h4>
                <p className="text-[11px] text-[#8e8e93] leading-relaxed">
                  Pick a chapter from the manuscript sidebar on the left or create a new chapter to begin drafting.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* Collapsed Center Rail Handle */}
        {!isCenterOpen && (isLeftOpen || isRightOpen) && (
          <button
            onClick={() => setIsCenterOpen(true)}
            title="Expand Writing Editor"
            className="group relative flex flex-col items-center justify-start pt-3 w-9 shrink-0 h-full bg-[#fcfcfb] dark:bg-[#1c1c1e] hover:bg-[#f6f6f4] dark:hover:bg-[#222224] border-r border-[#1c1c1e]/10 dark:border-white/10 text-[#636366] dark:text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-[#f5f5f7] transition-all select-none cursor-pointer z-10 shadow-2xs"
          >
            <div className="w-6 h-6 rounded-md flex items-center justify-center text-[#8e8e93] group-hover:text-[#1c1c1e] dark:group-hover:text-white transition-colors mb-3">
              <FileText className="w-3.5 h-3.5" />
            </div>
            <div
              className="flex items-center justify-center space-x-1 text-[10px] font-mono-cap tracking-wider uppercase text-[#8e8e93] group-hover:text-[#1c1c1e] dark:group-hover:text-white transition-colors select-none mt-2"
              style={{ writingMode: 'vertical-rl' }}
            >
              <span className="rotate-180">Open Editor</span>
            </div>
          </button>
        )}

        {/* ========================================================= */}
        {/* ALL PANELS CLOSED FALLBACK */}
        {/* ========================================================= */}
        {!isLeftOpen && !isCenterOpen && !isRightOpen && (
          <div className="flex-1 flex items-center justify-center p-6 bg-[#f6f6f4] dark:bg-[#161618] graphite-grid-bg relative">
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#f6f6f4]/60 to-[#f6f6f4] dark:via-[#161618]/60 dark:to-[#161618] pointer-events-none" />
            <div className="relative z-10 max-w-md w-full bg-[#fcfcfb] dark:bg-[#1c1c1e] rounded-2xl border border-[#1c1c1e]/10 dark:border-white/10 shadow-sm p-8 text-center space-y-5">
              <div className="w-12 h-12 rounded-xl bg-[#1c1c1e]/5 dark:bg-white/5 border border-[#1c1c1e]/10 dark:border-white/10 text-[#1c1c1e] dark:text-[#f5f5f7] flex items-center justify-center mx-auto">
                <Layout className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-[#1c1c1e] dark:text-[#f5f5f7]">All Panels Collapsed</h3>
                <p className="text-xs text-[#636366] dark:text-[#8e8e93] mt-1 leading-relaxed">
                  You are currently in an ultra-minimal workspace view. Click any panel below or restore all panels to continue writing.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2.5 pt-2">
                <button
                  onClick={() => setIsLeftOpen(true)}
                  className="flex flex-col items-center justify-center p-3 rounded-xl border border-[#1c1c1e]/10 dark:border-white/10 bg-white dark:bg-[#222224] hover:border-[#1c1c1e]/25 text-[#1c1c1e] dark:text-[#f5f5f7] transition-all text-xs font-medium space-y-1.5 cursor-pointer shadow-2xs"
                >
                  <PanelLeft className="w-4 h-4 text-[#8e8e93]" />
                  <span>Manuscript</span>
                </button>
                <button
                  onClick={() => setIsCenterOpen(true)}
                  className="flex flex-col items-center justify-center p-3 rounded-xl border border-[#1c1c1e]/10 dark:border-white/10 bg-white dark:bg-[#222224] hover:border-[#1c1c1e]/25 text-[#1c1c1e] dark:text-[#f5f5f7] transition-all text-xs font-medium space-y-1.5 cursor-pointer shadow-2xs"
                >
                  <FileText className="w-4 h-4 text-[#8e8e93]" />
                  <span>Editor</span>
                </button>
                <button
                  onClick={() => setIsRightOpen(true)}
                  className="flex flex-col items-center justify-center p-3 rounded-xl border border-[#1c1c1e]/10 dark:border-white/10 bg-white dark:bg-[#222224] hover:border-[#1c1c1e]/25 text-[#1c1c1e] dark:text-[#f5f5f7] transition-all text-xs font-medium space-y-1.5 cursor-pointer shadow-2xs"
                >
                  <ShieldCheck className="w-4 h-4 text-[#8e8e93]" />
                  <span>AI Guardian</span>
                </button>
              </div>

              <button
                onClick={() => {
                  setIsLeftOpen(true);
                  setIsCenterOpen(true);
                  setIsRightOpen(true);
                }}
                className="btn btn-solid btn-md w-full shadow-2xs"
              >
                <Maximize2 className="w-3.5 h-3.5 mr-1" />
                <span>Restore All Panels</span>
              </button>
            </div>
          </div>
        )}

        {/* Mobile Backdrop for Right Guardian Drawer */}
        {isRightOpen && (
          <div
            onClick={() => setIsRightOpen(false)}
            className="md:hidden fixed inset-0 bg-black/40 backdrop-blur-xs z-40 transition-opacity"
          />
        )}

        {/* ========================================================= */}
        {/* COLUMN 3: RIGHT AI GUARDIAN PANEL */}
        {/* ========================================================= */}
        <div
          className={`h-full transition-all duration-300 ease-in-out flex flex-col shrink-0 ${
            'fixed md:relative inset-y-0 right-0 z-50 md:z-auto bg-[#fcfcfb] dark:bg-[#1c1c1e] shadow-2xl md:shadow-none'
          } ${
            isRightOpen
              ? 'w-80 sm:w-96 max-w-[90vw] translate-x-0 opacity-100'
              : 'translate-x-full md:translate-x-0 md:w-0 md:min-w-0 md:opacity-0 md:pointer-events-none md:overflow-hidden'
          }`}
        >
          <aside className="w-full h-full bg-[#fcfcfb] dark:bg-[#1c1c1e] border-l border-[#1c1c1e]/10 dark:border-white/10 flex flex-col overflow-hidden text-left shadow-2xs transition-colors duration-200">
            {/* Guardian Panel Header */}
            <div className="p-3.5 sm:p-4 border-b border-[#1c1c1e]/10 dark:border-white/10 flex items-center justify-between bg-[#f6f6f4]/60 dark:bg-[#161618]/60">
              <div className="flex items-center space-x-2">
                <div className="w-6 h-6 rounded-md bg-[#1c1c1e] dark:bg-white text-white dark:text-[#1c1c1e] flex items-center justify-center shadow-2xs">
                  <ShieldCheck className="w-3.5 h-3.5" />
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-[#1c1c1e] dark:text-[#f5f5f7] tracking-tight">
                    AI Continuity Guardian
                  </h3>
                  <span className="text-[9.5px] text-[#8e8e93] font-mono-cap">
                    Evidence-Backed Narrative Memory
                  </span>
                </div>
              </div>

              <div className="flex items-center space-x-1">
                <button
                  onClick={handleRunContinuityScan}
                  disabled={analyzing}
                  title="Run live manuscript continuity scan"
                  className="p-1 text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-[#f5f5f7] hover:bg-[#1c1c1e]/5 dark:hover:bg-white/5 rounded-md transition-colors cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${analyzing ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setIsRightOpen(false)}
                  title="Close Guardian Panel"
                  className="p-1 text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-[#f5f5f7] hover:bg-[#1c1c1e]/5 dark:hover:bg-white/5 rounded-md transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4 md:hidden" />
                  <PanelRightClose className="hidden md:inline w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Filter Pills */}
            <div className="px-4 py-2 border-b border-[#1c1c1e]/10 dark:border-white/10 flex items-center space-x-1.5 overflow-x-auto text-[11px] font-mono-cap bg-[#f6f6f4]/30 dark:bg-[#161618]/30">
              <button
                onClick={() => setIssueFilter('current_chapter')}
                className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                  issueFilter === 'current_chapter'
                    ? 'bg-[#1c1c1e] dark:bg-white text-white dark:text-[#1c1c1e] font-medium shadow-2xs'
                    : 'text-[#636366] dark:text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-[#f5f5f7]'
                }`}
              >
                Ch {currentChapter?.chapter_number || 'Current'} ({currentChapterIssues.length})
              </button>
              <button
                onClick={() => setIssueFilter('all')}
                className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                  issueFilter === 'all'
                    ? 'bg-[#1c1c1e] dark:bg-white text-white dark:text-[#1c1c1e] font-medium shadow-2xs'
                    : 'text-[#636366] dark:text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-[#f5f5f7]'
                }`}
              >
                All Manuscript ({issues.length})
              </button>
              <button
                onClick={() => setIssueFilter('unresolved')}
                className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                  issueFilter === 'unresolved'
                    ? 'bg-[#1c1c1e] dark:bg-white text-white dark:text-[#1c1c1e] font-medium shadow-2xs'
                    : 'text-[#636366] dark:text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-[#f5f5f7]'
                }`}
              >
                Unresolved ({unresolvedCount})
              </button>
            </div>

            {/* Issues List Body */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-3.5">
              {displayedIssues.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-[#8e8e93]">
                  <CheckCircle className="w-8 h-8 text-[#1c1c1e] dark:text-[#f5f5f7] mb-2 stroke-1" />
                  <h4 className="text-xs font-semibold text-[#1c1c1e] dark:text-[#f5f5f7] mb-1">
                    Canon is Coherent
                  </h4>
                  {issueFilter === 'current_chapter' && issues.length > 0 ? (
                    <p className="text-[11px] text-[#8e8e93] leading-relaxed max-w-xs">
                      No active contradictions detected in Chapter {currentChapter?.chapter_number || 'this chapter'}.{' '}
                      <button
                        onClick={() => setIssueFilter('all')}
                        className="text-[#1c1c1e] dark:text-[#f5f5f7] underline font-medium cursor-pointer"
                      >
                        View all {issues.length} contradiction(s) across manuscript
                      </button>
                    </p>
                  ) : (
                    <p className="text-[11px] text-[#8e8e93] leading-relaxed max-w-xs">
                      No active contradictions detected in this view. Click "Analyze Chapter" above to run a deep scan against established story facts.
                    </p>
                  )}
                </div>
              ) : (
                displayedIssues.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    onStatusUpdate={handleStatusUpdate}
                  />
                ))
              )}
            </div>

            {/* Author Sovereignty Note */}
            <div className="p-3 bg-[#f6f6f4]/60 dark:bg-[#161618]/60 border-t border-[#1c1c1e]/10 dark:border-white/10 text-[10px] text-[#8e8e93] text-center font-mono-cap">
              Author Rule: The AI never alters your prose. You decide what is canon.
            </div>
          </aside>
        </div>

        {/* Collapsed Right Edge Slider Handle - DESKTOP ONLY */}
        {!isRightOpen && (
          <button
            onClick={() => setIsRightOpen(true)}
            title={`Expand AI Continuity Guardian (${unresolvedCount} unresolved)`}
            className="hidden md:flex group relative flex flex-col items-center justify-start pt-3 w-9 shrink-0 h-full bg-[#fcfcfb] dark:bg-[#1c1c1e] hover:bg-[#f6f6f4] dark:hover:bg-[#222224] border-l border-[#1c1c1e]/10 dark:border-white/10 text-[#636366] dark:text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-[#f5f5f7] transition-all select-none cursor-pointer z-10 shadow-2xs"
          >
            <div className="w-6 h-6 rounded-md flex items-center justify-center text-white bg-[#1c1c1e] dark:bg-white dark:text-[#1c1c1e] transition-colors mb-3 relative shadow-2xs">
              <ShieldCheck className="w-3.5 h-3.5" />
              {unresolvedCount > 0 && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full ring-2 ring-white dark:ring-[#1c1c1e] animate-pulse" />
              )}
            </div>
            <div
              className="flex items-center justify-center space-x-1.5 text-[10px] font-mono-cap tracking-wider uppercase text-[#8e8e93] group-hover:text-[#1c1c1e] dark:group-hover:text-white transition-colors select-none mt-2"
              style={{ writingMode: 'vertical-rl' }}
            >
              <span className="rotate-180">AI Guardian</span>
            </div>
            {unresolvedCount > 0 ? (
              <span className="mt-4 px-1.5 py-0.2 text-[9px] font-mono font-bold rounded-full bg-[#1c1c1e]/10 dark:bg-white/10 text-[#1c1c1e] dark:text-[#f5f5f7] border border-[#1c1c1e]/10 dark:border-white/10">
                {unresolvedCount}
              </span>
            ) : (
              <span className="mt-4 w-1.5 h-1.5 rounded-full bg-[#8e8e93]" title="Canon coherent" />
            )}
          </button>
        )}
      </div>

      {/* Floating World Graph / Lore Slide-over Drawer */}
      {showWorldGraphDrawer && (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-[#fcfcfb] dark:bg-[#1c1c1e] border-l border-[#1c1c1e]/10 dark:border-white/10 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
          <div className="px-5 py-4 border-b border-[#1c1c1e]/10 dark:border-white/10 flex items-center justify-between bg-[#f6f6f4]/60 dark:bg-[#161618]/60">
            <div className="flex items-center space-x-2">
              <GitFork className="w-4 h-4 text-[#8e8e93]" />
              <h3 className="text-xs font-semibold text-[#1c1c1e] dark:text-[#f5f5f7] font-mono-cap tracking-wider">
                Quick World Lore
              </h3>
            </div>
            <div className="flex items-center space-x-2">
              <a
                href={`/architect/${projectId}`}
                className="btn btn-outline btn-sm text-[11px]"
                title="Open in Story Architect"
              >
                <span>Architect</span>
                <ExternalLink className="w-3 h-3 ml-1" />
              </a>
              <button
                onClick={() => setShowWorldGraphDrawer(false)}
                className="p-1 text-[#8e8e93] hover:text-[#1c1c1e] dark:hover:text-white rounded cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="p-4 flex-1 overflow-y-auto space-y-3">
            <p className="text-xs text-[#636366] dark:text-[#8e8e93]">
              Quick reference of active world entities, canon status, and lore connections while writing.
            </p>

            <div className="space-y-2 pt-2">
              {(graphData?.nodes || []).length === 0 ? (
                <div className="py-12 text-center text-xs text-[#8e8e93] font-mono-cap">Loading world entities...</div>
              ) : (
                graphData.nodes.map((node) => (
                  <div
                    key={node.id}
                    className="p-3 rounded-xl border border-[#1c1c1e]/10 dark:border-white/10 bg-white dark:bg-[#222224] hover:border-[#1c1c1e]/25 dark:hover:border-white/25 transition-all flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-center space-x-1.5 mb-1">
                        <span className="text-xs font-semibold text-[#1c1c1e] dark:text-[#f5f5f7]">
                          {node.data?.label || node.id}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded-full uppercase bg-[#1c1c1e]/5 dark:bg-white/10 text-[#636366] dark:text-[#8e8e93] font-mono-cap">
                          {node.data?.entity_type || 'entity'}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#636366] dark:text-[#8e8e93] line-clamp-1">
                        {node.data?.description || 'No description available'}
                      </p>
                    </div>
                    <a
                      href={`/entity/${projectId}/${node.id}`}
                      className="text-xs font-medium text-[#1c1c1e] dark:text-[#f5f5f7] hover:underline shrink-0 ml-2"
                    >
                      Inspect &rarr;
                    </a>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Entity Matching Review Queue Drawer */}
      <EntityMatchingDrawer
        projectId={projectId}
        isOpen={showMatchingDrawer}
        onClose={() => setShowMatchingDrawer(false)}
        onCandidateResolved={() => {
          architectService.getMatchingCandidates(projectId).then((m) => {
            setMatchingCandidatesCount(m?.length || 0);
          });
        }}
      />
    </div>
  );
}
