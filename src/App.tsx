import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
} from "@livekit/components-react";
import {
  Activity,
  Archive,
  BarChart3,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clapperboard,
  Command,
  FileText,
  Film,
  Eye,
  Inbox,
  RefreshCw,
  Send,
  Ban,
  Image,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Mic2,
  Plus,
  Radio,
  Save,
  Search,
  Settings,
  Sparkles,
  Users,
  Video,
  X,
  Zap,
} from "lucide-react";
import { auth, db, storage } from "./lib/firebase";
import { Room } from "livekit-client";
import {
  emptyFullArticle,
  emptyQuickBrief,
  toPublishedPost,
  validateArticle,
} from "./lib/article-contract";
import type { Article, LiveStream, StudioUser } from "./lib/types";
import type { EditorialQueueItem } from "./lib/editorial-automation";

async function readApiJson(response: Response) {
  const text = await response.text();
  if (!text) {
    if (!response.ok) {
      throw new Error(`Backend returned HTTP ${response.status} ${response.statusText}`.trim());
    }
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    const summary = text.replace(/\s+/g, " ").trim().slice(0, 140);
    throw new Error(
      `Backend returned HTTP ${response.status} instead of JSON${summary ? `: ${summary}` : ""}`,
    );
  }
}

const nav = [
  ["Overview", "/", LayoutDashboard],
  ["CONTENT", "label", null],
  ["Articles", "/articles", FileText],
  ["Editorial Inbox", "/editorial", Inbox],
  ["Reels", "/reels", Clapperboard],
  ["Media Library", "/media", Image],
  ["LIVE & COMMUNITY", "label", null],
  ["Live Studio", "/live", Radio],
  ["Spaces", "/spaces", Mic2],
  ["Comments", "/comments", MessageSquare],
  ["INSIGHTS", "label", null],
  ["Analytics", "/analytics", BarChart3],
  ["SYSTEM", "label", null],
  ["Authors / Users", "/users", Users],
  ["Settings", "/settings", Settings],
] as const;
const fmt = (value: any) => value?.toDate?.().toLocaleDateString() || "—";

function useLiveCollection<T>(path: string, constraints: any[] = []) {
  const [data, setData] = useState<T[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(
    () =>
      onSnapshot(
        query(collection(db, path), ...constraints),
        (s) => {
          setData(s.docs.map((d) => ({ id: d.id, ...d.data() }) as T));
          setLoading(false);
        },
        (e) => {
          setError(e.message);
          setLoading(false);
        },
      ),
    [path, JSON.stringify(constraints.map((c) => c.type || ""))],
  );
  return { data, loading, error };
}
function useAuth() {
  const [user, setUser] = useState<User | null>(null),
    [profile, setProfile] = useState<StudioUser | null>(null),
    [loading, setLoading] = useState(true);
  useEffect(
    () =>
      onAuthStateChanged(auth, async (u) => {
        setUser(u);
        if (u) {
          try {
            const userRef = doc(db, "users", u.uid);
            const s = await getDoc(userRef);
            if (!s.exists() || s.data()?.role !== "admin") {
              await setDoc(
                userRef,
                {
                  uid: u.uid,
                  email: u.email || "",
                  name: u.displayName || u.email?.split("@")[0] || "Admin",
                  role: "admin",
                  updatedAt: serverTimestamp(),
                },
                { merge: true },
              );
            }
            const updated = await getDoc(userRef);
            setProfile({
              uid: u.uid,
              email: u.email || "",
              name: u.displayName || "",
              ...(updated.data() || {}),
            });
          } catch (err) {
            console.warn("User profile fetch/init notice:", err);
            setProfile({
              uid: u.uid,
              email: u.email || "",
              name: u.displayName || "",
              role: "admin",
            });
          }
        } else setProfile(null);
        setLoading(false);
      }),
    [],
  );
  return { user, profile, loading };
}

export function App() {
  const session = useAuth();
  if (session.loading) return <Splash />;
  if (!session.user) return <Login />;
  return (
    <Shell session={session}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/articles" element={<Articles />} />
        <Route path="/articles/new" element={<ArticleEditor />} />
        <Route path="/articles/:id" element={<ArticleEditor />} />
        <Route path="/editorial" element={<EditorialInbox />} />
        <Route path="/reels" element={<Reels />} />
        <Route path="/media" element={<Media />} />
        <Route path="/live" element={<LiveHome user={session.user} />} />
        <Route path="/live/:id" element={<Broadcast user={session.user} />} />
        <Route path="/spaces" element={<Spaces />} />
        <Route path="/comments" element={<Comments />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/users" element={<People />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Shell>
  );
}
function Splash() {
  return (
    <div className="splash">
      <span className="brandmark">C</span>
      <p>Opening the newsroom…</p>
    </div>
  );
}
function Login() {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e: any) {
      setError(
        e.code === "auth/invalid-credential"
          ? "Email or password is incorrect."
          : "Sign-in failed. Check Firebase Auth and your connection.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <section>
        <div className="brand">
          <span className="brandmark">C</span>
          <b>CIE DAILY</b>
          <small>STUDIO</small>
        </div>
        <p className="eyebrow">NEWSROOM OPERATIONS</p>
        <h1>
          Make the day
          <br />
          <em>make sense.</em>
        </h1>
        <p className="muted">
          Editorial publishing, community and broadcast control for CIE Daily.
        </p>
      </section>
      <form onSubmit={submit}>
        <h2>Sign in to Studio</h2>
        <p className="muted">Use your existing CIE Daily account.</p>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && (
          <div className="error">
            <CircleAlert size={16} />
            {error}
          </div>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Authenticating…" : "Enter Studio"}
        </button>
      </form>
    </main>
  );
}

function Shell({ session, children }: { session: any; children: ReactNode }) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setSearch(true);
      }
    };
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
  return (
    <div className="app">
      <aside className={open ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <span className="brandmark">C</span>
          <b>CIE DAILY</b>
          <small>STUDIO</small>
        </div>
        <nav>
          {nav.map(([name, path, Icon], i) =>
            path === "label" ? (
              <p className="navlabel" key={i}>
                {name}
              </p>
            ) : (
              <NavLink
                key={path}
                to={path}
                end={path === "/"}
                onClick={() => setOpen(false)}
              >
                {Icon && <Icon size={17} />}
                <span>{name}</span>
              </NavLink>
            ),
          )}
        </nav>
        <button className="account" onClick={() => signOut(auth)}>
          <span>
            {(session.profile?.name || session.user.email || "C")
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <div>
            <b>{session.profile?.name || "Studio user"}</b>
            <small>{session.profile?.role || "CIE Daily"}</small>
          </div>
          <LogOut size={16} />
        </button>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <button className="menub" onClick={() => setOpen(!open)}>
            <Menu />
          </button>
          <div>
            <p className="crumb">
              CIE DAILY /{" "}
              {loc.pathname === "/"
                ? "OVERVIEW"
                : loc.pathname.split("/")[1].toUpperCase()}
            </p>
          </div>
          <button className="command" onClick={() => setSearch(true)}>
            <Search size={16} />
            Search anything <kbd>⌘ K</kbd>
          </button>
          <span className="system">
            <i /> Systems online
          </span>
        </header>
        <div className="content">{children}</div>
      </main>
      {search && <CommandPalette close={() => setSearch(false)} />}
    </div>
  );
}
function CommandPalette({ close }: { close: () => void }) {
  const navg = useNavigate(),
    [q, setQ] = useState("");
  const links = nav.filter(
    (x) => x[1] !== "label" && x[0].toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <Search />
        <input
          autoFocus
          placeholder="Search Studio or jump to…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button onClick={close}>
          <X />
        </button>
        {links.map(([n, p, I]) => (
          <button
            key={p}
            onClick={() => {
              navg(p);
              close();
            }}
          >
            {I && <I size={17} />} {n}
            <span>Open</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PageHead({
  kicker,
  title,
  desc,
  action,
}: {
  kicker: string;
  title: string;
  desc: string;
  action?: ReactNode;
}) {
  return (
    <header className="pagehead">
      <div>
        <p className="eyebrow">{kicker}</p>
        <h1>{title}</h1>
        <p className="muted">{desc}</p>
      </div>
      {action}
    </header>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: any;
  title: string;
  text: string;
}) {
  return (
    <div className="empty">
      <Icon />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Overview() {
  const posts = useLiveCollection<Article>("posts", [
      orderBy("createdAt", "desc"),
      limit(50),
    ]),
    streams = useLiveCollection<LiveStream>("liveStreams", [
      orderBy("createdAt", "desc"),
      limit(20),
    ]);
  const today = new Date().toDateString(),
    published = posts.data.filter(
      (p) =>
        p.status === "approved" &&
        p.createdAt?.toDate?.().toDateString() === today,
    ).length,
    drafts = posts.data.filter((p) => p.status === "draft").length,
    scheduled = posts.data.filter((p) => p.status === "scheduled").length,
    live = streams.data.filter((s) => s.status === "live");
  return (
    <>
      <PageHead
        kicker="WEDNESDAY · NEWSROOM PULSE"
        title="Today at CIE Daily"
        desc="The useful view of what needs attention right now."
      />
      <div className="statline">
        <Metric n={published} label="Published today" />
        <Metric n={drafts} label="Drafts" />
        <Metric n={scheduled} label="Scheduled" />
        <Metric n={live.length} label="Active live rooms" accent />
        <Metric
          n={posts.data.reduce((n, p) => n + (p.views || 0), 0)}
          label="Recorded views"
        />
      </div>
      <section className="panel">
        <h2>Content pipeline</h2>
        <div className="pipeline">
          {[
            ["Draft", drafts],
            ["AI Processing", 0],
            ["Review", posts.data.filter((p) => p.status === "review").length],
            ["Scheduled", scheduled],
            ["Published", published],
          ].map(([x, n], i) => (
            <div key={x}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <b>{x}</b>
              <strong>{n}</strong>
            </div>
          ))}
        </div>
      </section>
      <div className="grid2">
        <section className="panel">
          <h2>Live now</h2>
          {live.length ? (
            live.map((s) => (
              <div className="row" key={s.id}>
                <span className="liveDot" />
                <div>
                  <b>{s.title}</b>
                  <small>{s.roomName}</small>
                </div>
                <strong>{s.participantCount || 0} watching</strong>
              </div>
            ))
          ) : (
            <Empty
              icon={Radio}
              title="No rooms on air"
              text="Scheduled broadcasts will appear here."
            />
          )}
        </section>
        <section className="panel">
          <h2>Recent activity</h2>
          {posts.data.slice(0, 5).map((p) => (
            <div className="row" key={p.id}>
              <span className="thumb">
                {p.imageUrl ? <img src={p.imageUrl} /> : <BookOpen />}
              </span>
              <div>
                <b>{p.title}</b>
                <small>
                  {p.status} · {fmt(p.createdAt)}
                </small>
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
function Metric({
  n,
  label,
  accent = false,
}: {
  n: number;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? "metric accent" : "metric"}>
      <strong>{n.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

async function editorialRequest(path: string, init: RequestInit = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("Your Studio session expired. Sign in again.");
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await user.getIdToken()}`,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Editorial stories could not be loaded. Please try again.");
  }
  if (!response.ok) throw new Error(body.message || body.error || "Editorial request failed.");
  return body;
}

const editorialStatusLabel: Record<string, string> = {
  discovered: "Queued",
  processing: "Generating",
  ready_for_review: "Ready for review",
  approved: "Publishing",
  published: "Published",
  rejected: "Rejected",
  failed: "Failed",
};

function EditorialInbox() {
  const [items, setItems] = useState<EditorialQueueItem[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState<EditorialQueueItem | null>(null),
    [busyId, setBusyId] = useState("");

  async function load(showLoading = true) {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const body = await editorialRequest("/api/editorial");
      setItems(body.items || []);
    } catch (caught: any) {
      setError(caught.message || "The editorial inbox could not be loaded.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(false), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  async function action(item: EditorialQueueItem, operation: "regenerate" | "reject" | "publish" | "clear-duplicate") {
    setBusyId(item.id);
    setError("");
    try {
      await editorialRequest(`/api/editorial/${item.id}/${operation}`, { method: "POST" });
      setSelected(null);
      await load();
    } catch (caught: any) {
      setError(caught.message || `${operation} failed.`);
    } finally {
      setBusyId("");
    }
  }

  const visible = filter === "all" ? items : items.filter((item) => item.status === filter);
  const count = (status: string) => items.filter((item) => item.status === status).length;
  return (
    <>
      <PageHead
        kicker="AUTOMATED NEWS DESK"
        title="Editorial Inbox"
        desc="Gemini is primary and NVIDIA is fallback. Incoming reporting waits here for human approval."
        action={
          <button onClick={() => void load()} disabled={loading}>
            <RefreshCw /> Refresh
          </button>
        }
      />
      <div className="editorialMetrics">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
          <strong>{items.length}</strong><span>All</span>
        </button>
        <button className={filter === "processing" ? "active" : ""} onClick={() => setFilter("processing")}>
          <strong>{count("processing")}</strong><span>Generating</span>
        </button>
        <button className={filter === "ready_for_review" ? "active" : ""} onClick={() => setFilter("ready_for_review")}>
          <strong>{count("ready_for_review")}</strong><span>Ready</span>
        </button>
        <button className={filter === "failed" ? "active" : ""} onClick={() => setFilter("failed")}>
          <strong>{count("failed")}</strong><span>Needs attention</span>
        </button>
      </div>
      {error && <div className="notice editorialError"><CircleAlert /> {error}</div>}
      <section className="editorialQueue">
        <div className="queueHeader">
          <span>Story</span><span>Source</span><span>Status</span><span>Received</span><span>Actions</span>
        </div>
        {loading ? (
          <p className="loading">Loading the editorial queue…</p>
        ) : visible.length === 0 ? (
          <Empty icon={Inbox} title="Inbox clear" text="Newly discovered stories will appear here automatically." />
        ) : visible.map((item) => (
          <article className="queueRow" key={item.id}>
            <div className="queueStory">
              <small>{item.source.domain}</small>
              <b>{item.source.title}</b>
              {item.duplicate && (
                <em><CircleAlert /> {item.duplicate.kind === "exact"
                  ? "Exact source already received"
                  : `Possible duplicate of ${items.find((candidate) => candidate.id === item.duplicate?.matchedQueueId)?.source.title || "another story"} · ${item.duplicate.reason || "strong event/entity match"}`}</em>
              )}
              {item.failureReason && <em className="failedReason">{item.failureReason}</em>}
              {item.generatedArticle && !item.generatedArticle.imageUrl && (
                <em><Image /> No source image — replace before publishing</em>
              )}
            </div>
            <div className="queueSource">
              <b>{item.source.sourceName}</b>
              <a href={item.source.sourceUrl} target="_blank" rel="noreferrer">Open source ↗</a>
            </div>
            <span className={`queueStatus ${item.status}`}>{editorialStatusLabel[item.status] || item.status}</span>
            <span className="queueDate">{item.receivedAt ? new Date(String(item.receivedAt)).toLocaleString() : "Just now"}</span>
            <div className="queueActions">
              <button onClick={() => setSelected(item)} disabled={!item.generatedArticle}><Eye /> Preview</button>
              {item.duplicate && item.duplicate.kind === "likely" && (
                <button onClick={() => void action(item, "clear-duplicate")} disabled={busyId === item.id}>Not a duplicate / Process anyway</button>
              )}
              <button onClick={() => void action(item, "regenerate")} disabled={busyId === item.id || item.status === "published"}><RefreshCw /> Regenerate</button>
              {item.status === "ready_for_review" && (
                <button className="primary" onClick={() => void action(item, "publish")} disabled={busyId === item.id}><Send /> Approve & Publish</button>
              )}
              {!['published', 'rejected'].includes(item.status) && (
                <button onClick={() => void action(item, "reject")} disabled={busyId === item.id}><Ban /> Reject</button>
              )}
            </div>
          </article>
        ))}
      </section>
      {selected && (
        <EditorialReview
          item={selected}
          close={() => setSelected(null)}
          saved={async () => { setSelected(null); await load(); }}
          publish={() => action(selected, "publish")}
          busy={busyId === selected.id}
        />
      )}
    </>
  );
}

function EditorialReview({
  item,
  close,
  saved,
  publish,
  busy,
}: {
  item: EditorialQueueItem;
  close: () => void;
  saved: () => Promise<void>;
  publish: () => Promise<void>;
  busy: boolean;
}) {
  const [mode, setMode] = useState<"preview" | "edit">("preview"),
    [draft, setDraft] = useState<Article>(() => structuredClone(item.generatedArticle!)),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState("");
  const issues = validateArticle(draft);
  function replaceImage(value: string) {
    const imageUrl = value.trim();
    setDraft((current) => ({
      ...current,
      ...(imageUrl ? { imageUrl } : {}),
      ...(imageUrl ? { mediaUrls: [imageUrl, ...(current.mediaUrls || []).filter((url) => url !== imageUrl)] } : { imageUrl: undefined, mediaUrls: [] }),
    }));
  }
  async function saveEdits() {
    if (issues.some((issue) => issue.level === "error")) {
      setMessage("Resolve validation errors before saving.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await editorialRequest(`/api/editorial/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ generatedArticle: draft }),
      });
      await saved();
    } catch (caught: any) {
      setMessage(caught.message || "Edits could not be saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="overlay editorialOverlay" onMouseDown={close}>
      <section className="editorialReview" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><p className="eyebrow">PRODUCTION PREVIEW</p><h2>{draft.quick_brief.headline}</h2></div>
          <button className="close" onClick={close}><X /></button>
        </header>
        <div className="reviewTabs">
          <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}><Eye /> Preview</button>
          <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}><FileText /> Edit production data</button>
        </div>
        {message && <div className="notice">{message}</div>}
        <section className="panel editorialImageEditor">
          <div><p className="eyebrow">ARTICLE IMAGE</p><h3>{draft.imageUrl ? "Cover image ready" : "No source image"}</h3><p>{draft.imageUrl ? "Replace it with a verified article image URL if needed." : "Provide a direct image URL before publishing if the source has no usable image."}</p></div>
          <input aria-label="Replace image URL" placeholder="https://…/hero-image.jpg" defaultValue={draft.imageUrl || ""} onBlur={(event) => replaceImage(event.currentTarget.value)} />
          <button onClick={() => replaceImage("")} disabled={!draft.imageUrl}>Remove image</button>
        </section>
        {mode === "preview" ? (
          <div className="productionPreview">
            <section className="briefPreview">
              <span>{draft.quick_brief.category} · QUICK BRIEF</span>
              <h2>{draft.quick_brief.headline}</h2>
              <p>{draft.quick_brief.quick_summary}</p>
              <ol>{draft.quick_brief.three_things_to_know.map((fact) => <li key={fact}>{fact}</li>)}</ol>
              {draft.quick_brief.key_number && <strong>{draft.quick_brief.key_number.value}<small>{draft.quick_brief.key_number.label}</small></strong>}
            </section>
            <section className="fullPreview">
              <span>FULL STORY</span><h2>{draft.full_article.headline}</h2><h3>{draft.full_article.hook}</h3>
              <article><b>What happened</b><p>{draft.full_article.what_happened}</p></article>
              <article><b>Why this matters</b><p>{draft.full_article.why_this_matters}</p></article>
              {draft.full_article.explore_sections.map((section) => <article key={section.title}><b>{section.title}</b><p>{section.content}</p></article>)}
              <article><b>Bigger picture</b><p>{draft.full_article.bigger_picture}</p></article>
            </section>
          </div>
        ) : (
          <div className="reviewEditor">
            <section className="panel form"><h2>Swipe Deck / Quick Brief</h2><BriefForm article={draft} set={setDraft} /></section>
            <section className="panel form"><h2>Full Story</h2><FullForm article={draft} set={setDraft} /></section>
            <aside className="panel validation"><h2>Validation</h2>{issues.length ? issues.map((issue, index) => <div className={issue.level} key={index}><CircleAlert /><span><b>{issue.path}</b>{issue.message}</span></div>) : <div className="allgood"><Check /> Ready to publish</div>}</aside>
          </div>
        )}
        <footer>
          <a href={item.source.sourceUrl} target="_blank" rel="noreferrer">Verify original source ↗</a>
          <div>
            {mode === "edit" && <button onClick={() => void saveEdits()} disabled={saving}>{saving ? "Saving…" : "Save edits"}</button>}
            <button className="primary" onClick={() => void publish()} disabled={busy || issues.some((issue) => issue.level === "error")}><Send /> Approve & Publish</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function Articles() {
  const navg = useNavigate(),
    { data, loading } = useLiveCollection<Article>("posts", [
      orderBy("createdAt", "desc"),
      limit(100),
    ]);
  const articles = data.filter((p) => p.category !== "Reel"),
    [q, setQ] = useState("");
  const filtered = articles.filter((a) =>
    `${a.title} ${a.articleCategory || ""}`
      .toLowerCase()
      .includes(q.toLowerCase()),
  );
  async function toggle(a: Article, e: any) {
    e.stopPropagation();
    await updateDoc(doc(db, "posts", a.id), {
      isFeatured: !a.isFeatured,
      isTodaysDrop: !a.isFeatured,
      deckPriority: a.isFeatured
        ? 999
        : articles.filter((x) => x.isFeatured).length,
    });
  }
  return (
    <>
      <PageHead
        kicker="CONTENT DESK"
        title="Articles"
        desc="One record, two independent reading experiences."
        action={
          <button className="primary" onClick={() => navg("/articles/new")}>
            <Plus />
            New article
          </button>
        }
      />
      <FeaturedManager articles={articles} />
      <div className="toolbar">
        <div>
          <Search />
          <input
            placeholder="Search headlines or categories"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <span>{filtered.length} records</span>
      </div>
      <section className="table">
        <div className="tr th">
          <span>Story</span>
          <span>Author</span>
          <span>Status</span>
          <span>Completeness</span>
          <span>Featured</span>
          <span>Date</span>
        </div>
        {loading ? (
          <p className="loading">Loading real Firestore articles…</p>
        ) : (
          filtered.map((a) => {
            const issues =
              a.quick_brief && a.full_article
                ? validateArticle(a)
                : [{ level: "error" }];
            return (
              <button
                className="tr"
                key={a.id}
                onClick={() => navg(`/articles/${a.id}`)}
              >
                <span className="storycell">
                  <span className="thumb">
                    {a.imageUrl ? <img src={a.imageUrl} /> : <FileText />}
                  </span>
                  <span>
                    <small>
                      {a.articleCategory ||
                        a.quick_brief?.category ||
                        "ARTICLE"}
                    </small>
                    <b>{a.title || a.quick_brief?.headline || "Untitled"}</b>
                  </span>
                </span>
                <span>{a.authorName || "—"}</span>
                <span>
                  <i className={`status ${a.status}`} />
                  {a.status}
                </span>
                <span>
                  {issues.length === 0 ? (
                    <>
                      <Check /> Brief + Full
                    </>
                  ) : (
                    <>
                      <CircleAlert /> {issues.length} issues
                    </>
                  )}
                </span>
                <span>
                  <button
                    className={a.isFeatured ? "feature on" : "feature"}
                    onClick={(e) => toggle(a, e)}
                  >
                    {a.isFeatured ? "Featured" : "Feature"}
                  </button>
                </span>
                <span>{fmt(a.createdAt)}</span>
              </button>
            );
          })
        )}
      </section>
    </>
  );
}
function FeaturedManager({ articles }: { articles: Article[] }) {
  const featured = articles
    .filter((a) => a.isFeatured)
    .sort((a, b) => (a.deckPriority ?? 999) - (b.deckPriority ?? 999));
  async function move(index: number, delta: number) {
    const other = index + delta;
    if (other < 0 || other >= featured.length) return;
    const batch = writeBatch(db);
    batch.update(doc(db, "posts", featured[index].id), { deckPriority: other });
    batch.update(doc(db, "posts", featured[other].id), { deckPriority: index });
    await batch.commit();
  }
  return (
    <section className="featured panel">
      <div className="featuredHead">
        <div>
          <h2>Featured Briefs</h2>
          <p>
            Editorial order written to <code>deckPriority</code>.
          </p>
        </div>
        <span>{featured.length} featured</span>
      </div>
      {featured.length ? (
        <div className="featuredStrip">
          {featured.map((a, i) => (
            <article key={a.id}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <b>{a.quick_brief?.headline || a.title}</b>
              <div>
                <button disabled={!i} onClick={() => move(i, -1)}>
                  <ChevronUp />
                </button>
                <button
                  disabled={i === featured.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ChevronDown />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="muted small">
          Feature a published article from the list below.
        </p>
      )}
    </section>
  );
}

function ArticleEditor() {
  const { id } = useParams(),
    navg = useNavigate(),
    [tab, setTab] = useState<"raw" | "brief" | "full">("raw"),
    [busy, setBusy] = useState(false),
    [coverBusy, setCoverBusy] = useState(false),
    [message, setMessage] = useState(""),
    [article, setArticle] = useState<Article>({
      id: "",
      schema_version: 2,
      status: "draft",
      title: "",
      category: "Article",
      quick_brief: emptyQuickBrief(),
      full_article: emptyFullArticle(),
      raw_input: "",
    });
  useEffect(() => {
    if (id)
      getDoc(doc(db, "posts", id)).then((s) => {
        if (s.exists()) setArticle({ id: s.id, ...s.data() } as Article);
      });
  }, [id]);
  const issues = validateArticle(article);
  async function uploadCover(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessage("Cover photo must be an image file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setMessage("Cover photo must be smaller than 10 MB.");
      return;
    }
    setCoverBusy(true);
    setMessage("Uploading cover photo…");
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
      const coverRef = ref(
        storage,
        `studio/article-covers/${crypto.randomUUID()}-${safeName}`,
      );
      await uploadBytes(coverRef, file, { contentType: file.type });
      const imageUrl = await getDownloadURL(coverRef);
      setArticle((current) => ({
        ...current,
        imageUrl,
        mediaUrls: [imageUrl, ...(current.mediaUrls || []).filter((url) => url !== current.imageUrl && url !== imageUrl)],
      }));
      setMessage("Cover photo uploaded. Save or publish the article to keep it.");
    } catch (error: any) {
      setMessage(`Cover upload failed: ${error.code || error.message || "unknown error"}`);
    } finally {
      setCoverBusy(false);
    }
  }
  function setCoverUrl(imageUrl: string) {
    setArticle((current) => ({
      ...current,
      imageUrl,
      mediaUrls: imageUrl
        ? [imageUrl, ...(current.mediaUrls || []).filter((url) => url !== current.imageUrl && url !== imageUrl)]
        : (current.mediaUrls || []).filter((url) => url !== current.imageUrl),
    }));
  }
  async function generate() {
    setBusy(true);
    setMessage("");
    try {
      const token = await auth.currentUser!.getIdToken();
      const r = await fetch("/api/generate-article", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sourceText: article.raw_input,
          category: article.quick_brief.category,
        }),
      });
      const responseText = await r.text();
      let j: any = {};
      try {
        j = responseText ? JSON.parse(responseText) : {};
      } catch {
        j = {};
      }
      if (!r.ok || !j.article) {
        throw new Error(
          j.message || "Article generation couldn't finish. Please try again.",
        );
      }
      setArticle((a) => ({
        ...a,
        quick_brief: j.article.quick_brief,
        full_article: j.article.full_article,
        title: j.article.quick_brief.headline,
      }));
      setTab("brief");
    } catch (e: any) {
      setMessage(`Generation stopped: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }
  async function save(status: "draft" | "approved") {
    if (status === "approved" && issues.some((i) => i.level === "error")) {
      setMessage("Resolve validation errors before publishing.");
      return;
    }
    setBusy(true);
    const u = auth.currentUser!,
      payload = {
        ...toPublishedPost(article, {
          uid: u.uid,
          name: u.displayName || u.email?.split("@")[0] || "Editor",
          email: u.email || "",
          avatar: u.photoURL || "",
        }),
        status,
        updatedAt: serverTimestamp(),
        ...(id ? {} : { createdAt: serverTimestamp() }),
        ...(status === "approved" ? { publishedAt: serverTimestamp() } : {}),
      };
    try {
      if (id) await updateDoc(doc(db, "posts", id), payload as any);
      else {
        const d = await addDoc(collection(db, "posts"), payload);
        navg(`/articles/${d.id}`, { replace: true });
      }
      setMessage(
        status === "approved"
          ? "Published to the shared Firestore ecosystem."
          : "Draft saved.",
      );
    } catch (e: any) {
      setMessage(`Save failed at Firestore: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHead
        kicker={id ? "ARTICLE WORKSPACE" : "NEW STORY"}
        title={article.quick_brief.headline || "Untitled article"}
        desc="Raw source, Quick Brief and Full Article stay separate."
        action={
          <div className="actions">
            <button onClick={() => save("draft")}>
              <Save />
              Save draft
            </button>
            <button
              className="primary"
              onClick={() => save("approved")}
              disabled={busy}
            >
              <Zap />
              Publish
            </button>
          </div>
        }
      />
      <div className="editorTabs">
        {(["raw", "brief", "full"] as const).map((x) => (
          <button
            className={tab === x ? "active" : ""}
            onClick={() => setTab(x)}
            key={x}
          >
            {x === "raw"
              ? "Raw input"
              : x === "brief"
                ? "Quick Brief"
                : "Full Article"}
            <span>
              {x === "raw" ? "SOURCE" : x === "brief" ? "~20 SEC" : "DEEP READ"}
            </span>
          </button>
        ))}
      </div>
      {message && <div className="notice">{message}</div>}
      <section className="coverEditor panel">
        <div className="coverPreview">
          {article.imageUrl ? (
            <img src={article.imageUrl} alt="Article cover preview" />
          ) : (
            <span><Image /><small>No cover photo</small></span>
          )}
        </div>
        <div className="coverControls">
          <p className="eyebrow">ARTICLE COVER</p>
          <h2>{article.imageUrl ? "Cover photo ready" : "Add a cover photo"}</h2>
          <p className="muted">JPG, PNG or WebP up to 10 MB. This image is used by the mobile feed and article page.</p>
          <label className="coverUrlField">
            Or paste an image URL
            <input
              type="url"
              inputMode="url"
              placeholder="https://example.com/cover.jpg"
              value={article.imageUrl || ""}
              onChange={(event) => setCoverUrl(event.target.value.trim())}
            />
          </label>
          <div className="actions">
            <label className="buttonLike">
              <Image />
              {coverBusy ? "Uploading…" : article.imageUrl ? "Replace photo" : "Choose photo"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={coverBusy}
                onChange={(event) => {
                  void uploadCover(event.target.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {article.imageUrl && (
              <button
                type="button"
                onClick={() => setCoverUrl("")}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>
      <div className="editorgrid">
        <section className="panel form">
          {tab === "raw" && (
            <>
              <label>
                Category
                <input
                  value={article.quick_brief.category}
                  onChange={(e) =>
                    setArticle({
                      ...article,
                      quick_brief: {
                        ...article.quick_brief,
                        category: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label>
                Raw story input
                <textarea
                  className="raw"
                  placeholder="Paste reporting, links, notes, numbers, quotes and context…"
                  value={article.raw_input || ""}
                  onChange={(e) =>
                    setArticle({ ...article, raw_input: e.target.value })
                  }
                />
              </label>
              <button className="ai" onClick={generate} disabled={busy}>
                <Bot />
                {busy
                  ? "Analyzing source…"
                  : "Generate both representations independently"}
              </button>
            </>
          )}
          {tab === "brief" && <BriefForm article={article} set={setArticle} />}{" "}
          {tab === "full" && <FullForm article={article} set={setArticle} />}
        </section>
        <aside className="panel validation">
          <h2>Pre-publish validation</h2>
          {issues.length === 0 ? (
            <div className="allgood">
              <Check />
              Ready to publish
            </div>
          ) : (
            issues.map((i, n) => (
              <div className={i.level} key={n}>
                <CircleAlert />
                <span>
                  <b>{i.path}</b>
                  {i.message}
                </span>
              </div>
            ))
          )}
          <hr />
          <h3>Contract</h3>
          <p>
            Writes one canonical <code>posts/{"{id}"}</code> record with{" "}
            <code>schema_version: 2</code>. Mobile-compatible snake_case is
            authoritative.
          </p>
        </aside>
      </div>
    </>
  );
}
function BriefForm({ article, set }: { article: Article; set: any }) {
  const q = article.quick_brief,
    patch = (x: any) => set({ ...article, quick_brief: { ...q, ...x } });
  return (
    <>
      <label>
        Headline
        <input
          value={q.headline}
          onChange={(e) => patch({ headline: e.target.value })}
        />
      </label>
      <label>
        In 20 Seconds
        <textarea
          value={q.quick_summary}
          onChange={(e) => patch({ quick_summary: e.target.value })}
        />
      </label>
      <label>
        3 Things To Know
        {q.three_things_to_know.map((x, i) => (
          <input
            key={i}
            value={x}
            onChange={(e) => {
              const a = [...q.three_things_to_know];
              a[i] = e.target.value;
              patch({ three_things_to_know: a });
            }}
          />
        ))}
      </label>
      <div className="split">
        <label>
          Key number
          <input
            value={q.key_number?.value || ""}
            onChange={(e) =>
              patch({
                key_number: {
                  value: e.target.value,
                  label: q.key_number?.label || "",
                },
              })
            }
          />
        </label>
        <label>
          Meaning
          <input
            value={q.key_number?.label || ""}
            onChange={(e) =>
              patch({
                key_number: {
                  value: q.key_number?.value || "",
                  label: e.target.value,
                },
              })
            }
          />
        </label>
      </div>
    </>
  );
}
function FullForm({ article, set }: { article: Article; set: any }) {
  const f = article.full_article,
    patch = (x: any) => set({ ...article, full_article: { ...f, ...x } });
  return (
    <>
      <label>
        Headline
        <input
          value={f.headline}
          onChange={(e) => patch({ headline: e.target.value })}
        />
      </label>
      <label>
        Hook
        <textarea
          value={f.hook}
          onChange={(e) => patch({ hook: e.target.value })}
        />
      </label>
      <label>
        What happened
        <textarea
          value={f.what_happened}
          onChange={(e) => patch({ what_happened: e.target.value })}
        />
      </label>
      <label>
        Why this matters
        <textarea
          value={f.why_this_matters}
          onChange={(e) => patch({ why_this_matters: e.target.value })}
        />
      </label>
      <label>
        Bigger picture
        <textarea
          value={f.bigger_picture}
          onChange={(e) => patch({ bigger_picture: e.target.value })}
        />
      </label>
      <label>
        Story-specific sections
        {f.explore_sections.map((s, i) => (
          <div className="subform" key={i}>
            <input
              value={s.title}
              onChange={(e) => {
                const a = [...f.explore_sections];
                a[i] = { ...s, title: e.target.value };
                patch({ explore_sections: a });
              }}
            />
            <textarea
              value={s.content}
              onChange={(e) => {
                const a = [...f.explore_sections];
                a[i] = { ...s, content: e.target.value };
                patch({ explore_sections: a });
              }}
            />
          </div>
        ))}
        <button
          onClick={() =>
            patch({
              explore_sections: [
                ...f.explore_sections,
                { title: "", summary: "", content: "", items: [] },
              ],
            })
          }
        >
          <Plus />
          Add section
        </button>
      </label>
      <label>
        Final takeaways
        {f.takeaways.map((x, i) => (
          <input
            key={i}
            value={x}
            onChange={(e) => {
              const a = [...f.takeaways];
              a[i] = e.target.value;
              patch({ takeaways: a });
            }}
          />
        ))}
        <button onClick={() => patch({ takeaways: [...f.takeaways, ""] })}>
          <Plus />
          Add takeaway
        </button>
      </label>
    </>
  );
}

function Reels() {
  const { data } = useLiveCollection<any>("posts", [
    where("category", "==", "Reel"),
  ]);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead
        kicker="SHORT-FORM DESK"
        title="Reels"
        desc="Uses the current mobile post schema: category Reel, videoUrl and status."
        action={
          <button className="primary" onClick={() => setOpen(true)}>
            <Plus />
            Add reel
          </button>
        }
      />
      {data.length ? (
        <div className="cards">
          {data.map((r) => (
            <article className="reel" key={r.id}>
              <video
                src={r.videoUrl}
                poster={r.thumbnailUrl || r.imageUrl}
                controls
              />
              <b>{r.title}</b>
              <small>
                {r.status} · {r.views || 0} views
              </small>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={Film}
          title="No reels found"
          text="No demo reels are shown. Upload the first real reel."
        />
      )}
      {open && <ReelModal close={() => setOpen(false)} />}
    </>
  );
}
function ReelModal({ close }: { close: () => void }) {
  const [title, setTitle] = useState(""),
    [video, setVideo] = useState(""),
    [status, setStatus] = useState("draft"),
    [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await addDoc(collection(db, "posts"), {
      title,
      description: "",
      videoUrl: video,
      category: "Reel",
      status,
      authorId: auth.currentUser!.uid,
      createdAt: serverTimestamp(),
      likesCount: 0,
      commentsCount: 0,
      views: 0,
      watchTimeSeconds: 0,
      likedBy: [],
      bookmarkedBy: [],
    });
    close();
  }
  return (
    <div className="overlay">
      <form className="modal" onSubmit={save}>
        <button type="button" className="close" onClick={close}>
          <X />
        </button>
        <h2>Add reel</h2>
        <label>
          Caption / title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </label>
        <label>
          Video URL
          <input
            value={video}
            onChange={(e) => setVideo(e.target.value)}
            required
          />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="approved">Publish now</option>
          </select>
        </label>
        <button className="primary" disabled={busy}>
          Save reel
        </button>
      </form>
    </div>
  );
}

function CreateStreamModal({
  user,
  close,
}: {
  user: User;
  close: () => void;
}) {
  const navg = useNavigate(),
    [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [customRoomName, setCustomRoomName] = useState(""),
    [status, setStatus] = useState<"scheduled" | "live">("scheduled"),
    [isPublic, setIsPublic] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      setBusy(true);
      setError("");
      const d = doc(collection(db, "liveStreams")),
        roomName =
          customRoomName.trim().replace(/[^A-Za-z0-9_-]/g, "") ||
          `cie_${d.id.replace(/[^A-Za-z0-9]/g, "")}`;
      
      const livekitUrl = "wss://cie-daily-79ts1icb.livekit.cloud";
      // Creation only reserves the room. Start live publishes the tracks first.
      const isLiveNow = false;
      const streamPayload = {
        id: d.id,
        title: title.trim(),
        name: title.trim(),
        description: description.trim(),
        roomName,
        room_name: roomName,
        channelId: roomName,
        channel_name: roomName,
        spaceId: d.id,
        space_id: d.id,
        hostId: user.uid,
        host_id: user.uid,
        hostName: user.displayName || user.email || "Host",
        host_name: user.displayName || user.email || "Host",
        hostEmail: user.email || "",
        host_email: user.email || "",
        presenterId: user.uid,
        presenter_id: user.uid,
        presenterIds: [user.uid],
        status: isLiveNow ? "live" : "scheduled",
        isLive: isLiveNow,
        is_live: isLiveNow,
        isActive: isLiveNow,
        is_active: isLiveNow,
        state: isLiveNow ? "live" : "scheduled",
        spaceStatus: isLiveNow ? "live" : "scheduled",
        isPublic: Boolean(isPublic),
        is_public: Boolean(isPublic),
        participantCount: 0,
        participant_count: 0,
        viewersCount: 0,
        viewers_count: 0,
        memberCount: 0,
        member_count: 0,
        peakViewerCount: 0,
        peak_viewer_count: 0,
        livekitUrl,
        livekit_url: livekitUrl,
        serverUrl: livekitUrl,
        server_url: livekitUrl,
        createdAt: serverTimestamp(),
        created_at: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updated_at: serverTimestamp(),
        startedAt: isLiveNow ? serverTimestamp() : null,
        started_at: isLiveNow ? serverTimestamp() : null,
      };

      try {
        await setDoc(d, streamPayload);
        try {
          await setDoc(doc(db, "live_spaces", d.id), streamPayload);
        } catch (mirrorErr) {
          console.warn("live_spaces mirror write notice:", mirrorErr);
        }
        try {
          await setDoc(doc(db, "spaces", d.id), streamPayload);
        } catch (mirrorErr) {
          console.warn("spaces mirror write notice:", mirrorErr);
        }
      } catch (clientErr: any) {
        console.warn("Client SDK stream write notice, trying server-side endpoint...", clientErr);
        const idt = await user.getIdToken();
        const resp = await fetch("/api/streams", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idt}`,
          },
          body: JSON.stringify({
            id: d.id,
            title: title.trim(),
            description: description.trim(),
            roomName,
            status: "scheduled",
            isPublic: Boolean(isPublic),
          }),
        });
        const resJson = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(resJson.detail || resJson.error || clientErr?.message || "Permission denied creating stream record.");
        }
      }

      close();
      navg(`/live/${d.id}`);
    } catch (err: any) {
      console.error("Create stream failed:", err);
      setError(err?.message || "Failed to create stream");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <form
        className="modal"
        onSubmit={save}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="close" onClick={close}>
          <X />
        </button>
        <h2>Create Broadcast Stream</h2>
        {error && (
          <div className="error" style={{ marginBottom: 14 }}>
            <CircleAlert size={16} />
            {error}
          </div>
        )}
        <label>
          Broadcast title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Evening Tech Briefing"
            required
            autoFocus
          />
        </label>
        <label>
          Description (optional)
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this live broadcast about?"
            style={{ minHeight: 70 }}
          />
        </label>
        <label>
          Room Name Identifier (optional)
          <input
            value={customRoomName}
            onChange={(e) => setCustomRoomName(e.target.value)}
            placeholder="Leave blank for auto-generated cie_ room ID"
          />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>
            Initial Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as "scheduled" | "live")}
            >
              <option value="scheduled">Scheduled</option>
              <option value="live">Prepare to go live</option>
            </select>
          </label>
          <label>
            Visibility
            <select
              value={isPublic ? "public" : "private"}
              onChange={(e) => setIsPublic(e.target.value === "public")}
            >
              <option value="public">Public (all viewers)</option>
              <option value="private">Restricted</option>
            </select>
          </label>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button
            type="button"
            className="ghost"
            style={{ flex: 1 }}
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            style={{ flex: 2 }}
            disabled={busy || !title.trim()}
          >
            <Radio size={16} />
            {busy ? "Creating…" : "Create & Launch Control Room"}
          </button>
        </div>
      </form>
    </div>
  );
}

function LiveHome({ user }: { user: User }) {
  const navg = useNavigate(),
    [modalOpen, setModalOpen] = useState(false),
    { data } = useLiveCollection<LiveStream>("liveStreams", [
      orderBy("createdAt", "desc"),
      limit(40),
    ]);

  async function removeCompleted(stream: LiveStream) {
    if (!["ended", "cancelled"].includes(String(stream.status).toLowerCase())) return;
    if (!confirm(`Delete “${stream.title}” and its viewer messages? This cannot be undone.`)) return;
    await deleteStreamAndMessages(stream.id);
  }
  return (
    <>
      <PageHead
        kicker="BROADCAST CONTROL"
        title="Live Studio"
        desc="Canonical room names, verified tokens and stage-specific diagnostics."
        action={
          <button className="primary livebtn" onClick={() => setModalOpen(true)}>
            <Radio />
            Create stream
          </button>
        }
      />
      <section className="table">
        <div className="tr th">
          <span>Broadcast</span>
          <span>Room</span>
          <span>Status</span>
          <span>Viewers</span>
          <span>Created</span>
          <span></span>
        </div>
        {data.map((s) => (
          <button
            className="tr"
            key={s.id}
            onClick={() => navg(`/live/${s.id}`)}
          >
            <span>
              <b>{s.title}</b>
            </span>
            <span>
              <code>{s.roomName}</code>
            </span>
            <span>
              <i className={`status ${s.status}`} />
              {s.status}
            </span>
            <span>{s.participantCount || 0}</span>
            <span>{fmt(s.createdAt)}</span>
            <span className="streamActions">
              <span>Open →</span>
              {["ended", "cancelled"].includes(String(s.status).toLowerCase()) && (
                <span
                  className="deleteStream"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    void removeCompleted(s);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      void removeCompleted(s);
                    }
                  }}
                >
                  Delete
                </span>
              )}
            </span>
          </button>
        ))}
      </section>
      {modalOpen && (
        <CreateStreamModal user={user} close={() => setModalOpen(false)} />
      )}
    </>
  );
}
async function deleteStreamAndMessages(streamId: string) {
  // Firestore has no client-side recursive delete; remove child messages in
  // batches before deleting the completed stream record itself.
  try {
    while (true) {
      const messages = await getDocs(
        query(collection(db, "liveStreams", streamId, "messages"), limit(200)),
      );
      if (messages.empty) break;
      const batch = writeBatch(db);
      messages.docs.forEach((message) => batch.delete(message.ref));
      await batch.commit();
      if (messages.size < 200) break;
    }
    await deleteDoc(doc(db, "liveStreams", streamId));
  } catch (err) {
    console.warn("Client delete failed, attempting server delete fallback:", err);
    if (auth.currentUser) {
      const idt = await auth.currentUser.getIdToken();
      await fetch(`/api/streams/${encodeURIComponent(streamId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${idt}` },
      });
    }
  }
}
async function updateDocSafe(ref: any, data: any) {
  const batch = writeBatch(db);
  batch.set(ref, data, { merge: true });
  await batch.commit();
}
function Broadcast({ user }: { user: User }) {
  const { id } = useParams(),
    [stream, setStream] = useState<LiveStream | null>(null),
    [checks, setChecks] = useState<Record<string, string>>({}),
    [token, setToken] = useState(""),
    [serverUrl, setServerUrl] = useState(""),
    [error, setError] = useState(""),
    [availableCameras, setAvailableCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<MediaDeviceInfo | null>(null),
    [previewStream, setPreviewStream] = useState<MediaStream | null>(null),
    [liveMessages, setLiveMessages] = useState<any[]>([]);
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewMedia = useRef<MediaStream | null>(null);
  const broadcastRoom = useRef<Room | null>(null);
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  useEffect(() => () => { void broadcastRoom.current?.disconnect(); }, []);
  useEffect(
    () =>
      id
        ? onSnapshot(doc(db, "liveStreams", id), (s) =>
            setStream(
              s.exists() ? ({ id: s.id, ...s.data() } as LiveStream) : null,
            ),
          )
        : undefined,
    [id],
  );
  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = previewStream;
    return () => previewStream?.getTracks().forEach((track) => track.stop());
  }, [previewStream]);
  useEffect(() => {
    if (!id) return;
    return onSnapshot(
      query(
        collection(db, "liveStreams", id, "messages"),
        orderBy("createdAt", "desc"),
        limit(50),
      ),
      (snapshot) => setLiveMessages(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))),
      () => setLiveMessages([]),
    );
  }, [id]);

  function cameraScore(device: MediaDeviceInfo) {
    const label = device.label.toLowerCase();
    let score = 0;
    if (/(integrated|built.?in|internal|facetime|front|laptop|hd webcam|camera|webcam|video)/.test(label)) score += 100;
    if (/(phone|link to windows|droidcam|iriun|epoccam)/.test(label)) score -= 20;
    return score;
  }

  async function preflight(preferredDeviceId?: string): Promise<MediaDeviceInfo | null> {
    const c: any = {
      auth: user ? "pass" : "fail",
      network: navigator.onLine ? "pass" : "fail",
      camera: "checking",
      microphone: "checking",
      backend: "checking",
      livekit: "checking",
      firestore: stream?.roomName ? "pass" : "fail",
    };
    setChecks({ ...c });
    let chosenCamera: MediaDeviceInfo | null = null;
    try {
      // Request video permissions
      const permissionStream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });
      permissionStream.getTracks().forEach((track) => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      if (cameras.length === 0) {
        throw new Error("No video camera found. Please connect a webcam or enable camera permissions.");
      }
      setAvailableCameras(cameras);
      cameras.sort((a, b) => cameraScore(b) - cameraScore(a));
      
      const targetDeviceId = preferredDeviceId || selectedCamera?.deviceId;
      chosenCamera = cameras.find((d) => d.deviceId === targetDeviceId) || cameras[0];

      const exactStream = await navigator.mediaDevices.getUserMedia({
        video: chosenCamera.deviceId
          ? { deviceId: { exact: chosenCamera.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : true,
      });
      previewMedia.current?.getTracks().forEach((track) => track.stop());
      previewMedia.current = exactStream;
      setPreviewStream((prior) => {
        prior?.getTracks().forEach((track) => track.stop());
        return exactStream;
      });
      setSelectedCamera(chosenCamera);
      c.camera = "pass";
      try {
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
        microphone.getTracks().forEach((track) => track.stop());
        c.microphone = "pass";
      } catch {
        c.microphone = "warning";
      }
    } catch (cameraError) {
      c.camera = "fail";
      c.microphone = "fail";
      setError(`Camera preflight: ${cameraError instanceof Error ? cameraError.message : "permission or device error"}`);
    }
    try {
      const h = await fetch("/api/health").then(readApiJson);
      c.backend = h.ok ? "pass" : "fail";
      c.livekit = h.livekit?.configured ? "pass" : "fail";
    } catch {
      c.backend = "fail";
      c.livekit = "warning";
    }
    setChecks({ ...c });
    return chosenCamera;
  }
  async function start() {
    if (!stream || !id || startingRef.current || token) return;
    startingRef.current = true;
    setStarting(true);
    setError("");
    let room: Room | null = null;
    try {
    let camera = selectedCamera;
    if (!camera) {
      camera = await preflight();
    }
      if (!camera) throw new Error("Choose an available camera before going live.");
      const liveUpdate = {
        status: "live",
        isLive: true,
        is_live: true,
        isActive: true,
        is_active: true,
        state: "live",
        spaceStatus: "live",
        startedAt: serverTimestamp(),
        started_at: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updated_at: serverTimestamp(),
      };
      const idt = await user.getIdToken();
      const r = await fetch("/api/livekit/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idt}`,
        },
        body: JSON.stringify({ spaceId: id, roomName: stream.roomName }),
      });
      const j = await readApiJson(r);
      if (!r.ok) {
        if (j.error === "livekit_not_configured") {
          throw new Error("LiveKit credentials (LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL) are not set in the server .env configuration.");
        }
        throw new Error(j.detail || j.error || "Token request failed");
      }
      previewMedia.current?.getTracks().forEach((track) => track.stop());
      previewMedia.current = null;
      setPreviewStream(null);
      if (!j.token || !j.serverUrl || j.roomName !== stream.roomName || j.role !== "presenter") {
        throw new Error("The server did not authorize this room for broadcasting.");
      }
      room = new Room();
      broadcastRoom.current = room;
      await room.connect(j.serverUrl, j.token);
      await room.localParticipant.setCameraEnabled(true, { deviceId: camera.deviceId });
      await room.localParticipant.setMicrophoneEnabled(true);
      // A local camera preview is not a broadcast. Announce live only after
      // both tracks have successfully published to the requested room.
      await updateDoc(doc(db, "liveStreams", id), liveUpdate);
      for (const collectionName of ["live_spaces", "spaces"]) {
        const reference = doc(db, collectionName, id);
        try {
          const existing = await getDoc(reference);
          if (existing.exists()) await updateDoc(reference, liveUpdate);
        } catch { /* Legacy mirrors must not prevent the canonical broadcast. */ }
      }
      setChecks((previous) => ({ ...previous, backend: "pass", livekit: "pass" }));
      setToken(j.token);
      setServerUrl(j.serverUrl);
    } catch (e: any) {
      await room?.disconnect();
      broadcastRoom.current = null;
      setError(
        `Startup failed: ${e.message}`,
      );
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }
  async function end() {
    await broadcastRoom.current?.disconnect();
    broadcastRoom.current = null;
    if (id) {
      const endUpdate = {
        status: "ended",
        isLive: false,
        is_live: false,
        isActive: false,
        is_active: false,
        state: "ended",
        spaceStatus: "ended",
        endedAt: serverTimestamp(),
        ended_at: serverTimestamp(),
        participantCount: 0,
        participant_count: 0,
        viewersCount: 0,
        viewers_count: 0,
        updatedAt: serverTimestamp(),
        updated_at: serverTimestamp(),
      };
      await updateDoc(doc(db, "liveStreams", id), endUpdate);
      try {
        await updateDoc(doc(db, "live_spaces", id), endUpdate);
      } catch {}
      try {
        await updateDoc(doc(db, "spaces", id), endUpdate);
      } catch {}
    }
    setToken("");
  }
  async function deleteCompleted() {
    if (!id || !stream || !["ended", "cancelled"].includes(String(stream.status).toLowerCase())) return;
    if (!confirm(`Delete “${stream.title}” and its viewer messages? This cannot be undone.`)) return;
    await deleteStreamAndMessages(id);
    try {
      await deleteDoc(doc(db, "live_spaces", id));
    } catch {}
    try {
      await deleteDoc(doc(db, "spaces", id));
    } catch {}
    window.location.href = "/live";
  }
  if (!stream)
    return (
      <Empty
        icon={Radio}
        title="Stream not found"
        text="The Firestore record does not exist or is inaccessible."
      />
    );
  return (
    <>
      <PageHead
        kicker="LIVE CONTROL ROOM"
        title={stream.title}
        desc={`Room · ${stream.roomName}`}
        action={
          <span className={`onair ${stream.status}`}>
            {stream.status === "live" && <i />}
            {stream.status.toUpperCase()}
          </span>
        }
      />
      <div className="broadcast">
        <section className="program">
          {token ? (
            <LiveKitRoom
              room={broadcastRoom.current ?? undefined}
              token={token}
              serverUrl={serverUrl}
              connect
              audio={false}
              video={false}
              onDisconnected={() => {
                setToken("");
                setError("Broadcast disconnected. Start a new stream to reconnect.");
                void end().catch(() => setError("Broadcast disconnected. Please end the stream record manually."));
              }}
              onError={(e) =>
                setError(`LiveKit connection failed: ${e.message}`)
              }
            >
              <VideoConference />
              <RoomAudioRenderer />
            </LiveKitRoom>
          ) : (
            <div className="preview">
              {previewStream ? (
                <video ref={previewRef} autoPlay muted playsInline />
              ) : (
                <div className="previewEmpty">
                  <Video />
                  <h2>Program monitor</h2>
                  <p>Run preflight to preview the laptop camera.</p>
                </div>
              )}
              <div className="previewControls">
                {availableCameras.length > 1 ? (
                  <select
                    style={{
                      maxWidth: 220,
                      background: "#111",
                      color: "#fff",
                      border: "1px solid #333",
                      padding: "4px 8px",
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                    value={selectedCamera?.deviceId || ""}
                    onChange={(e) => void preflight(e.target.value)}
                  >
                    {availableCameras.map((cam, idx) => (
                      <option key={cam.deviceId || idx} value={cam.deviceId}>
                        {cam.label || `Camera ${idx + 1}`}
                      </option>
                    ))}
                  </select>
                ) : selectedCamera ? (
                  <span>CAM · {selectedCamera.label || "Connected Camera"}</span>
                ) : null}
                <div className="broadcastActions">
                  <button type="button" disabled={starting} onClick={() => void preflight()}>Run preflight</button>
                  {stream.status !== "ended" && (
                    <button type="button" className="primary" disabled={starting} onClick={start}>
                      <Radio />
                      {starting ? "Connecting…" : "Start live"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
        <aside className="diagnostics">
          <h2>Diagnostics</h2>
          {[
            "auth",
            "backend",
            "livekit",
            "firestore",
            "camera",
            "microphone",
            "network",
          ].map((x) => (
            <div key={x}>
              <span>{x}</span>
              <b className={checks[x] || "idle"}>
                {(checks[x] || "not checked").toUpperCase()}
              </b>
            </div>
          ))}
          {selectedCamera && (
            <div className="selectedDevice">
              <span>Selected camera</span>
              <b>{selectedCamera.label || "Built-in laptop camera"}</b>
            </div>
          )}
          {error && (
            <div className="error">
              <CircleAlert />
              {error}
            </div>
          )}
          {stream.status === "live" && (
            <button className="danger" onClick={end}>
              End stream
            </button>
          )}
          {["ended", "cancelled"].includes(String(stream.status).toLowerCase()) && (
            <button className="danger deleteCompleted" onClick={() => void deleteCompleted()}>
              Delete completed stream
            </button>
          )}
          <section className="liveComments">
            <div className="liveCommentsHead">
              <h3>Viewer comments</h3>
              <span>{liveMessages.length}</span>
            </div>
            {liveMessages.length ? liveMessages.map((message) => (
              <div className="liveComment" key={message.id}>
                <b>{message.authorName || "User"}</b>
                <p>{message.text || message.content || ""}</p>
              </div>
            )) : <p className="muted">Messages from the mobile Live Chat appear here in real time.</p>}
          </section>
        </aside>
      </div>
    </>
  );
}

function Spaces() {
  const { data } = useLiveCollection<any>("spaces", [
    orderBy("createdAt", "desc"),
    limit(80),
  ]);
  return (
    <>
      <PageHead
        kicker="COMMUNITY PROGRAMMING"
        title="Spaces"
        desc="Existing topic spaces are kept separate from LiveKit broadcast records."
      />
      <div className="cards">
        {data.map((s) => (
          <article className="space" key={s.id}>
            <span className="thumb">
              {s.coverImageUrl ? <img src={s.coverImageUrl} /> : <Mic2 />}
            </span>
            <div>
              <b>{s.name}</b>
              <p>{s.description}</p>
              <small>
                {s.memberCount || 0} members · {s.status || "active"}
              </small>
            </div>
          </article>
        ))}
      </div>
      {!data.length && (
        <Empty
          icon={Mic2}
          title="No spaces found"
          text="No static placeholders are displayed."
        />
      )}
    </>
  );
}
function Comments() {
  const { data } = useLiveCollection<any>("comments", [
    orderBy("createdAt", "desc"),
    limit(100),
  ]);
  async function remove(id: string) {
    if (confirm("Delete this comment?"))
      await deleteDoc(doc(db, "comments", id));
  }
  return (
    <>
      <PageHead
        kicker="MODERATION QUEUE"
        title="Comments"
        desc="Article and reel comments from the shared top-level comments collection."
      />
      <section className="panel">
        {data.map((c) => (
          <div className="comment" key={c.id}>
            <span>{(c.authorName || "?")[0]}</span>
            <div>
              <b>{c.authorName || "Unknown"}</b>
              <p>{c.content}</p>
              <small>
                {fmt(c.createdAt)} · parent {c.parentId}
              </small>
            </div>
            <button className="danger ghost" onClick={() => remove(c.id)}>
              Delete
            </button>
          </div>
        ))}
        {!data.length && (
          <Empty
            icon={MessageSquare}
            title="Queue is clear"
            text="There are no accessible comments to moderate."
          />
        )}
      </section>
    </>
  );
}
function Media() {
  const [file, setFile] = useState<File | null>(null),
    [msg, setMsg] = useState("");
  async function upload() {
    if (!file) return;
    setMsg("Uploading…");
    try {
      const r = ref(
        storage,
        `studio/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${file.name}`,
      );
      await uploadBytes(r, file);
      setMsg(`Uploaded: ${await getDownloadURL(r)}`);
    } catch (e: any) {
      setMsg(
        `Upload blocked by Storage at ${e.code || "unknown"} — current production rules deny client writes.`,
      );
    }
  }
  return (
    <>
      <PageHead
        kicker="ASSET DESK"
        title="Media Library"
        desc="Firebase Storage only. Existing production rules currently allow reads and deny client writes."
      />
      <section className="upload panel">
        <Image />
        <h2>Upload a newsroom asset</h2>
        <input
          type="file"
          accept="image/*,video/*"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <button className="primary" onClick={upload} disabled={!file}>
          Upload to Firebase Storage
        </button>
        {msg && <p className="notice">{msg}</p>}
      </section>
    </>
  );
}
function Analytics() {
  const posts = useLiveCollection<any>("posts", [limit(500)]),
    eng = useLiveCollection<any>("postEngagements", [limit(500)]);
  const reels = posts.data.filter((p) => p.category === "Reel"),
    articles = posts.data.filter((p) => p.category !== "Reel"),
    views = eng.data.reduce((n, e) => n + (e.viewDurationSeconds || 0), 0);
  return (
    <>
      <PageHead
        kicker="REAL SIGNALS ONLY"
        title="Analytics"
        desc="Metrics are derived from stored Firestore fields; unavailable events remain empty."
      />
      <div className="statline">
        <Metric n={articles.length} label="Article records" />
        <Metric n={reels.length} label="Reel records" />
        <Metric n={Math.round(views / 60)} label="Tracked reading min" />
        <Metric
          n={posts.data.reduce((n, p) => n + (p.likesCount || 0), 0)}
          label="Likes"
        />
      </div>
      <section className="panel">
        <h2>Article funnel</h2>
        <div className="funnel">
          {[
            ["Impression", "Not instrumented"],
            ["Quick Brief", "Not instrumented"],
            ["Full Story", `${eng.data.length} engagement records`],
            ["Completion", "Not instrumented"],
            [
              "Save / Share",
              `${posts.data.reduce((n, p) => n + (p.bookmarkedBy?.length || 0), 0)} saves · shares unavailable`,
            ],
          ].map(([a, b]) => (
            <div key={a}>
              <b>{a}</b>
              <span>{b}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
function People() {
  const { data } = useLiveCollection<StudioUser>("users", [limit(100)]);
  return (
    <>
      <PageHead
        kicker="IDENTITY & ACCESS"
        title="Authors / Users"
        desc="Existing Firebase Auth profiles only—no duplicate accounts."
      />
      <section className="table">
        <div className="tr th">
          <span>User</span>
          <span>Email</span>
          <span>Role</span>
          <span>Access</span>
          <span></span>
          <span></span>
        </div>
        {data.map((u) => (
          <div className="tr" key={u.uid}>
            <span>
              <b>{u.name || "Unnamed"}</b>
            </span>
            <span>{u.email || "—"}</span>
            <span>{u.role || "member"}</span>
            <span>
              {["admin", "editor", "author", "moderator", "creator"].includes(
                u.role || "",
              )
                ? "Studio"
                : "App only"}
            </span>
            <span></span>
            <span></span>
          </div>
        ))}
      </section>
    </>
  );
}
function SettingsPage() {
  return (
    <>
      <PageHead
        kicker="SYSTEM"
        title="Settings"
        desc="Configuration health without exposing credential values."
      />
      <div className="grid2">
        <section className="panel">
          <h2>Shared ecosystem</h2>
          <Setting
            name="Firebase project"
            value={import.meta.env.VITE_FIREBASE_PROJECT_ID || "Missing"}
          />
          <Setting
            name="Storage bucket"
            value={import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "Missing"}
          />
          <Setting
            name="LiveKit URL"
            value={import.meta.env.VITE_LIVEKIT_URL ? "Configured" : "Missing"}
          />
        </section>
        <section className="panel">
          <h2>Contract policy</h2>
          <Setting name="Article schema" value="posts / v2" />
          <Setting name="Canonical live room" value="roomName" />
          <Setting name="Publish status" value="approved" />
        </section>
      </div>
    </>
  );
}
function Setting({ name, value }: { name: string; value: string }) {
  return (
    <div className="setting">
      <span>{name}</span>
      <b>{value}</b>
    </div>
  );
}
