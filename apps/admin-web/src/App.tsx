import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Snackbar,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
} from '@mui/material';
import { io } from 'socket.io-client';
import type {
  AdminAction,
  CommandReceipt,
  RateChange,
  RateEvent,
  Summary,
  UserState,
} from '../../../packages/contracts/src/index';
import { api, ApiError, demoToken, demoUserToken } from './api';
import { ActivityChart } from './ActivityChart';

type Snapshot = { users: UserState[]; nextCursor: string | null; asOf: string };
type TopUser = { userId: string; admitted: number; bypassed: number; chargedUsage: number };
type Health = {
  stale: boolean;
  outboxBacklog: number | null;
  oldestPendingAt?: string | null;
};
type History = {
  requests: RateEvent[];
  nextCursor: string | null;
  buckets: { at: string; regular: number; bypassed: number; denied: number }[];
};
type AdminCommand = {
  command_id: string;
  action: AdminAction;
  actor_id: string;
  created_at: string;
  applied_at: string | null;
  status: string;
  last_error: string | null;
};
type Action = {
  kind: 'limit' | 'extra-quota' | 'bypass' | 'reset';
  value: string;
  key: string;
};
const stamp = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
function identity(value: string): string {
  try {
    return JSON.parse(value)[1];
  } catch {
    return value;
  }
}

// Read the saved command arguments, so older entries keep showing the values
// that were requested even after the user's settings change again.
function commandDescription(action: AdminAction): string {
  switch (action.type) {
    case 'limit':
      return `Base limit: ${action.value.toLocaleString()} requests / rolling hour`;
    case 'extra-quota':
      return `Extra quota: ${action.value.toLocaleString()} requests / rolling hour`;
    case 'bypass':
      return `Bypass: ${action.value ? 'enabled' : 'disabled'}`;
    case 'reset':
      return 'Reset charged usage; preserve quota settings';
  }
}
function Status({ user }: { user: UserState }) {
  return (
    <div className="badges">
      <Chip
        size="small"
        label={user.status}
        color={user.status === 'OK' ? 'success' : user.status === 'Warning' ? 'warning' : 'error'}
        variant="outlined"
      />
      {user.bypassEnabled && (
        <Chip size="small" label="Bypass on" color="info" variant="outlined" />
      )}
    </div>
  );
}

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('admin-token') ?? '');
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [users, setUsers] = useState<UserState[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [top, setTop] = useState<TopUser[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastHeartbeat, setLastHeartbeat] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [active, setActive] = useState('');
  const [cursor, setCursor] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<UserState | null>(null);
  const [range, setRange] = useState<'hour' | 'day'>('hour');
  const [history, setHistory] = useState<History | null>(null);
  const [commands, setCommands] = useState<AdminCommand[]>([]);
  const [action, setAction] = useState<Action | null>(null);
  const [saving, setSaving] = useState(false);
  const [demoUser, setDemoUser] = useState('alice');
  const [demoCount, setDemoCount] = useState('1');
  const [demoBusy, setDemoBusy] = useState(false);
  const requestVersion = useRef(0);
  const detailVersion = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const detailTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const report = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) {
      sessionStorage.removeItem('admin-token');
      setToken('');
    }
    setError((reason as Error).message);
  }, []);
  const loadDetail = useCallback(async () => {
    const id = selectedRef.current;
    if (!id || !token) return;
    const version = ++detailVersion.current;
    try {
      const [user, hist, audit] = await Promise.all([
        api<UserState>(`/management/users/${encodeURIComponent(id)}`, token),
        api<History>(`/management/users/${encodeURIComponent(id)}/requests?range=${range}`, token),
        api<AdminCommand[]>(`/control/admin/users/${encodeURIComponent(id)}/commands`, token),
      ]);
      if (version !== detailVersion.current || selectedRef.current !== id) return;
      setSelected((current) =>
        current?.userId === id && current.userVersion > user.userVersion ? current : user,
      );
      setHistory(hist);
      setCommands(audit);
    } catch (reason) {
      report(reason);
    }
  }, [token, range, report]);
  const load = useCallback(async () => {
    if (!token) return;
    const version = ++requestVersion.current;
    const since = active ? new Date(Date.now() - Number(active) * 3600000).toISOString() : '';
    const params = new URLSearchParams({ limit: '100' });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (since) params.set('lastActiveSince', since);
    if (cursor) params.set('cursor', cursor);
    try {
      const [snapshot, stats, ranking, serviceHealth] = await Promise.all([
        api<Snapshot>(`/management/users?${params}`, token),
        api<Summary>('/management/analytics/summary', token),
        api<TopUser[]>('/management/analytics/top-users', token),
        api<Health>('/management/status', token),
      ]);
      if (version !== requestVersion.current) return;
      setUsers(snapshot.users);
      setNextCursor(snapshot.nextCursor);
      setSummary(stats);
      setTop(ranking);
      setHealth(serviceHealth);
      setSnapshotAt(snapshot.asOf);
      setLoaded(true);
    } catch (reason) {
      report(reason);
    }
  }, [token, search, status, active, cursor, report]);
  const loaders = useRef({ load, loadDetail });
  loaders.current = { load, loadDetail };

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setCursor('');
  }, [search, status, active]);
  useEffect(() => {
    if (!token) return;
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load, token]);
  useEffect(() => {
    setHistory(null);
    setCommands([]);
    if (selectedId) void loadDetail();
  }, [selectedId, loadDetail]);
  useEffect(() => {
    if (!token) return;
    const socket = io({ transports: ['websocket'], auth: { token } });
    socket.on('connect', () => {
      setConnected(true);
      // Refresh after subscribing, including on reconnect: missed notifications
      // do not need replay because the GET endpoints return current state.
      socket.emit('subscribe', () => {
        void loaders.current.load();
        void loaders.current.loadDetail();
      });
    });
    function receive(change: RateChange) {
      // Coalesce queries without postponing them forever during steady traffic.
      if (!refreshTimer.current)
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = undefined;
          void loaders.current.load();
        }, 200);
      if (selectedRef.current === change.userId && !detailTimer.current)
        detailTimer.current = setTimeout(() => {
          detailTimer.current = undefined;
          void loaders.current.loadDetail();
        }, 250);
    }
    socket.on('rate:update', receive);
    socket.on('rate:limit_exceeded', receive);
    socket.on('rate:heartbeat', (value: Health) => {
      setHealth(value);
      setLastHeartbeat(Date.now());
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    const fallback = setInterval(() => {
      void loaders.current.load();
      void loaders.current.loadDetail();
    }, 30000);
    return () => {
      socket.disconnect();
      clearInterval(fallback);
      clearTimeout(refreshTimer.current);
      clearTimeout(detailTimer.current);
      refreshTimer.current = undefined;
      detailTimer.current = undefined;
    };
  }, [token]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setLoginBusy(true);
    setError('');
    try {
      const value = await demoToken('admin', password);
      setPassword('');
      sessionStorage.setItem('admin-token', value);
      setToken(value);
    } catch (reason) {
      report(reason);
    } finally {
      setLoginBusy(false);
    }
  }
  async function generateTraffic() {
    const count = Number(demoCount);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      setError('Choose between 1 and 200 requests');
      return;
    }
    setDemoBusy(true);
    try {
      const userToken = await demoUserToken(demoUser, token);
      let admitted = 0;
      let denied = 0;
      for (let offset = 0; offset < count; offset += 20) {
        const responses = await Promise.all(
          Array.from({ length: Math.min(20, count - offset) }, () =>
            fetch('/data/demo', { headers: { authorization: `Bearer ${userToken}` } }),
          ),
        );
        for (const response of responses) {
          if (response.ok) admitted++;
          else if (response.status === 429) denied++;
          else throw new Error(`Demo request failed (${response.status})`);
        }
      }
      setNotice(`${identity(demoUser)}: ${admitted} admitted · ${denied} throttled`);
      void load();
    } catch (reason) {
      report(reason);
    } finally {
      setDemoBusy(false);
    }
  }
  async function submitAction() {
    if (!action || !selected) return;
    const numeric = Number(action.value);
    if (
      (action.kind === 'limit' || action.kind === 'extra-quota') &&
      (!Number.isInteger(numeric) ||
        numeric < (action.kind === 'limit' ? 1 : 0) ||
        numeric > 1_000_000)
    ) {
      setError('Enter a valid whole number, up to 1,000,000');
      return;
    }
    setSaving(true);
    try {
      const body = {
        ...(action.kind === 'bypass'
          ? { enabled: action.value === 'true' }
          : action.kind === 'reset'
            ? {}
            : { value: numeric }),
      };
      const receipt = await api<CommandReceipt>(
        `/control/admin/users/${encodeURIComponent(selected.userId)}/${action.kind}`,
        token,
        {
          method: action.kind === 'reset' ? 'POST' : 'PUT',
          headers: { 'idempotency-key': action.key },
          body: JSON.stringify(body),
        },
      );
      // The response is the committed data-plane state, even if management
      // has not consumed its event yet. Never replace a newer streamed state.
      setSelected((current) =>
        !current || receipt.state.userVersion > current.userVersion ? receipt.state : current,
      );
      setNotice('Change applied to the data plane.');
      setAction(null);
      void loadDetail();
    } catch (reason) {
      report(reason);
    } finally {
      setSaving(false);
    }
  }
  function openAction(kind: Action['kind']) {
    if (!selected) return;
    setError('');
    setAction({
      kind,
      key: crypto.randomUUID(),
      value:
        kind === 'limit'
          ? String(selected.baseLimit)
          : kind === 'extra-quota'
            ? String(selected.extraQuota)
            : String(!selected.bypassEnabled),
    });
  }
  async function moreHistory() {
    if (!selected || !history?.nextCursor) return;
    try {
      const page = await api<History>(
        `/management/users/${encodeURIComponent(selected.userId)}/requests?${new URLSearchParams({ range, cursor: history.nextCursor })}`,
        token,
      );
      setHistory((current) =>
        current ? { ...page, requests: [...current.requests, ...page.requests] } : page,
      );
    } catch (reason) {
      report(reason);
    }
  }
  const stale =
    !connected ||
    !lastHeartbeat ||
    now - lastHeartbeat > 5000 ||
    health?.stale ||
    (!!health?.oldestPendingAt && now - Date.parse(health.oldestPendingAt) > 5000);
  if (!token)
    return (
      <div className="login-shell">
        <div className="login-brand">
          <div className="brandmark">s.</div>
          <span>spikerz</span>
        </div>
        <form className="login-card" onSubmit={login}>
          <span className="eyebrow">LOCAL DEVELOPMENT</span>
          <h1>
            Stay ahead
            <br />
            of the limit.
          </h1>
          <p>
            Sign in to explore live traffic, adjust user quotas, and keep every request accounted
            for.
          </p>
          <TextField
            fullWidth
            label="Admin account"
            value="admin"
            slotProps={{ input: { readOnly: true } }}
          />
          <TextField
            fullWidth
            label="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          {error && <Alert severity="error">{error}</Alert>}
          <Button variant="contained" size="large" type="submit" disabled={loginBusy}>
            {loginBusy ? 'Signing in…' : 'Open rate control →'}
          </Button>
        </form>
        <p className="login-foot">SPIKERZ / REQUEST INTELLIGENCE</p>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="logo">
          <div className="brandmark">s.</div>spikerz<span>LAB</span>
        </div>
        <div className="workspace-tag">
          WORKSPACE <strong>Rate limiter demo</strong>
        </div>
        <div className="nav-label">MONITOR</div>
        <div className="nav-item active">
          <span>◫</span> Rate control <b>01</b>
        </div>
        <div className="side-note">
          <span className="small-dot" /> Three planes. One clear view.
          <p>Exact rolling quotas with independent admission, control, and observability.</p>
        </div>
        <div className="sidebar-footer">
          <div className="avatar">A</div>
          <div>
            Administrator<small>Local development</small>
          </div>
          <Button
            size="small"
            onClick={() => {
              sessionStorage.removeItem('admin-token');
              setToken('');
            }}
          >
            Exit
          </Button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> <strong>Rate control</strong>
          </span>
          <div className="live-indicator">
            <i className={stale ? 'dot amber' : 'dot'} />
            {stale ? 'Sync delayed' : 'Live updates'}
            <span className="environment">LOCAL</span>
          </div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">TRAFFIC & QUOTAS</span>
              <h1>
                Rate control<span>.</span>
              </h1>
              <p>A live pulse on usage. A clear path for every request.</p>
            </div>
            <div className="heading-meta">
              <span className="rolling-label">↻ Exact rolling hour</span>
              <small>Snapshot {stamp(snapshotAt)}</small>
            </div>
          </div>
          {error && (
            <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          {stale && loaded && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Updates are delayed. Values reflect the last observed state. Outbox backlog:{' '}
              {health?.outboxBacklog ?? 'unknown'}.
            </Alert>
          )}
          <div className="summary-grid">
            <section className="metric">
              <span>
                Observed users <span>↗</span>
              </span>
              <strong>{summary?.totalUsers ?? '—'}</strong>
              <small>Distinct authenticated users</small>
            </section>
            <section className="metric">
              <span>
                Approaching capacity <span className="metric-warning">◔</span>
              </span>
              <strong>{summary ? `${summary.nearLimitPercent.toFixed(1)}%` : '—'}</strong>
              <small>90% to below 100% of charged quota</small>
            </section>
            <section className="metric">
              <span>
                Throttled today <span className="metric-error">⊘</span>
              </span>
              <strong>{summary?.deniedToday ?? '—'}</strong>
              <small>HTTP 429 responses · UTC day</small>
            </section>
          </div>
          <div className="content-grid">
            <section className="panel users-panel">
              <div className="panel-title">
                <div>
                  <h2>
                    User activity <span className="count-badge">{users.length}</span>
                  </h2>
                  <p>Quota counts include charged admissions only.</p>
                </div>
                <Button variant="outlined" size="small" onClick={() => void load()}>
                  ↻ Refresh
                </Button>
              </div>
              <div className="filters">
                <TextField
                  label="Search user ID"
                  placeholder="Find a user…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  sx={{ flex: 1, minWidth: 160 }}
                />
                <FormControl size="small" sx={{ minWidth: 130 }}>
                  <InputLabel>Status</InputLabel>
                  <Select
                    label="Status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <MenuItem value="">All statuses</MenuItem>
                    {['OK', 'Warning', 'Exceeded'].map((value) => (
                      <MenuItem key={value} value={value}>
                        {value}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 140 }}>
                  <InputLabel>Last active</InputLabel>
                  <Select
                    label="Last active"
                    value={active}
                    onChange={(event) => setActive(event.target.value)}
                  >
                    <MenuItem value="">Any time</MenuItem>
                    <MenuItem value="1">Past hour</MenuItem>
                    <MenuItem value="24">Past day</MenuItem>
                  </Select>
                </FormControl>
              </div>
              <TableContainer>
                <Table size="small" aria-label="Live user quotas">
                  <TableHead>
                    <TableRow>
                      <TableCell>User</TableCell>
                      <TableCell>Remaining / Total</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Next quota change</TableCell>
                      <TableCell>Last request</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow
                        key={user.userId}
                        hover
                        className="user-row"
                        onClick={() => {
                          setSelected(user);
                          setSelectedId(user.userId);
                        }}
                      >
                        <TableCell>
                          <div className="user-cell">
                            <div className="avatar">
                              {identity(user.userId).slice(0, 1).toUpperCase()}
                            </div>
                            <div>
                              <strong>{identity(user.userId)}</strong>
                              <Tooltip title={user.userId}>
                                <small className="user-id">{user.userId}</small>
                              </Tooltip>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="quota-label">
                            <b>{user.remaining.toLocaleString()}</b>
                            <span>/ {user.capacity.toLocaleString()}</span>
                          </div>
                          <LinearProgress
                            variant="determinate"
                            value={Math.min(100, (user.used / user.capacity) * 100)}
                            color={
                              user.status === 'Exceeded'
                                ? 'error'
                                : user.status === 'Warning'
                                  ? 'warning'
                                  : 'primary'
                            }
                            sx={{ height: 4, borderRadius: 2, mt: 1, width: 105 }}
                          />
                        </TableCell>
                        <TableCell>
                          <Status user={user} />
                        </TableCell>
                        <TableCell className="date-cell">
                          {stamp(user.nextChangeAt)}
                          {user.status === 'Exceeded' && user.nextAllowedAt && (
                            <small>Allowed {stamp(user.nextAllowedAt)}</small>
                          )}
                        </TableCell>
                        <TableCell className="date-cell">{stamp(user.lastRequestAt)}</TableCell>
                        <TableCell>
                          <Button size="small" aria-label={`View ${identity(user.userId)}`}>
                            ↗
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!users.length && (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <div className="empty-state">
                            {!loaded ? (
                              <CircularProgress size={24} />
                            ) : (
                              <>
                                <span>⌁</span>
                                <h3>
                                  {search || status || active
                                    ? 'No matching users'
                                    : 'Ready for the first request'}
                                </h3>
                                <p>
                                  {search || status || active
                                    ? 'Adjust your filters to see more activity.'
                                    : 'Send demo traffic below to watch quotas update live.'}
                                </p>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
              <div className="table-footer">
                <small>Individual requests expire after one hour. No scheduled reset.</small>
                <div>
                  {cursor && (
                    <Button size="small" onClick={() => setCursor('')}>
                      First page
                    </Button>
                  )}
                  {nextCursor && (
                    <Button size="small" onClick={() => setCursor(nextCursor)}>
                      Next page →
                    </Button>
                  )}
                </div>
              </div>
            </section>
            <section className="panel ranking">
              <div className="panel-title">
                <div>
                  <h2>Most active</h2>
                  <p>Admitted in the past hour</p>
                </div>
                <span>↗</span>
              </div>
              {!top.length && (
                <div className="empty-ranking">Your busiest users will appear here.</div>
              )}
              {top.map((user, index) => (
                <button
                  className="rank-row"
                  key={user.userId}
                  onClick={() => {
                    setSelected(null);
                    setSelectedId(user.userId);
                  }}
                >
                  <span className="rank-number">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{identity(user.userId)}</strong>
                    <small>
                      {user.chargedUsage} charged · {user.bypassed} bypassed
                    </small>
                  </div>
                  <b>{user.admitted}</b>
                </button>
              ))}
              <div className="ranking-note">
                Bypassed admissions count toward activity, while quota usage stays separate.
              </div>
            </section>
          </div>
          <section className="panel demo-panel">
            <div>
              <span className="eyebrow">TRY IT LIVE</span>
              <h2>Put the limiter to work.</h2>
              <p>Send concurrent requests as a verified demo user.</p>
            </div>
            <div className="demo-controls">
              <FormControl size="small" sx={{ minWidth: 110 }}>
                <InputLabel>User</InputLabel>
                <Select
                  label="User"
                  value={demoUser}
                  onChange={(event) => setDemoUser(event.target.value)}
                >
                  {['alice', 'bob', 'charlie'].map((value) => (
                    <MenuItem value={value} key={value}>
                      {value}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label="Requests"
                type="number"
                value={demoCount}
                onChange={(event) => setDemoCount(event.target.value)}
                sx={{ width: 100 }}
                slotProps={{ htmlInput: { min: 1, max: 200 } }}
              />
              <Button
                variant="contained"
                disabled={demoBusy}
                onClick={() => void generateTraffic()}
              >
                {demoBusy ? 'Sending…' : 'Send requests →'}
              </Button>
            </div>
          </section>
          <footer className="page-footer">
            <span>SPIKERZ / RATE CONTROL</span>
            <span>Default: 100 requests / rolling hour · All times local unless marked UTC</span>
          </footer>
        </div>
      </main>
      <Drawer
        anchor="right"
        open={!!selectedId}
        onClose={() => setSelectedId(null)}
        sx={{ '& .MuiDrawer-paper': { width: { xs: '100%', md: 650 }, p: 3 } }}
      >
        <div className="drawer-heading">
          <span className="eyebrow">USER INSPECTOR</span>
          <Button onClick={() => setSelectedId(null)}>Close ×</Button>
        </div>
        {selected ? (
          <>
            <h1 className="detail-name">{identity(selected.userId)}</h1>
            <code className="full-id">{selected.userId}</code>
            <Status user={selected} />
            <div className="detail-stats">
              <div>
                <small>Remaining</small>
                <strong>
                  {selected.remaining} <em>/ {selected.capacity}</em>
                </strong>
              </div>
              <div>
                <small>Charged usage</small>
                <strong>{selected.used}</strong>
              </div>
              <div>
                <small>Base + extra</small>
                <strong>
                  {selected.baseLimit} <em>+ {selected.extraQuota}</em>
                </strong>
              </div>
            </div>
            <div className="detail-times">
              <p>
                Next quota change <b>{stamp(selected.nextChangeAt)}</b>
              </p>
              <p>
                Next admission available{' '}
                <b>
                  {selected.bypassEnabled ? 'Enforcement paused' : stamp(selected.nextAllowedAt)}
                </b>
              </p>
              <p>
                Last manual reset <b>{stamp(selected.lastManualResetAt)}</b>
              </p>
              <p>
                Applied revision <b>{selected.policyRevision}</b>
              </p>
              <p>
                Observed at <b>{stamp(selected.asOf)}</b>
              </p>
            </div>
            <h2>Quota controls</h2>
            <p className="section-help">
              Extra quota and bypass persist until explicitly changed. Reset clears charged usage
              and preserves policy.
            </p>
            <div className="control-buttons">
              <Button variant="outlined" disabled={saving} onClick={() => openAction('limit')}>
                Set base limit
              </Button>
              <Button
                variant="outlined"
                disabled={saving}
                onClick={() => openAction('extra-quota')}
              >
                Set extra quota
              </Button>
              <Button variant="outlined" disabled={saving} onClick={() => openAction('bypass')}>
                {selected.bypassEnabled ? 'Disable bypass' : 'Enable bypass'}
              </Button>
              <Button
                variant="outlined"
                color="warning"
                disabled={saving}
                onClick={() => openAction('reset')}
              >
                Reset usage
              </Button>
            </div>
            {!!commands.length && (
              <div className="commands">
                {commands.slice(0, 5).map((command) => (
                  <div key={command.command_id}>
                    <div className="command-details">
                      <strong>{commandDescription(command.action)}</strong>
                      <span className="command-actor">By {identity(command.actor_id)}</span>
                      <div className="command-times">
                        <span>
                          Requested{' '}
                          <time dateTime={command.created_at}>{stamp(command.created_at)}</time>
                        </span>
                        {command.applied_at && (
                          <span>
                            Applied{' '}
                            <time dateTime={command.applied_at}>{stamp(command.applied_at)}</time>
                          </span>
                        )}
                      </div>
                    </div>
                    <Chip
                      size="small"
                      label={command.status === 'unconfirmed' ? 'Outcome unknown' : command.status}
                      color={
                        command.status === 'applied'
                          ? 'success'
                          : command.status === 'failed'
                            ? 'error'
                            : 'warning'
                      }
                      variant="outlined"
                    />
                    {command.last_error && (
                      <small className="command-error">{command.last_error}</small>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="section-heading">
              <h2>Activity history</h2>
              <div>
                <Button
                  size="small"
                  variant={range === 'hour' ? 'contained' : 'text'}
                  onClick={() => setRange('hour')}
                >
                  Hour
                </Button>
                <Button
                  size="small"
                  variant={range === 'day' ? 'contained' : 'text'}
                  onClick={() => setRange('day')}
                >
                  Day
                </Button>
              </div>
            </div>
            <p className="section-help">
              All decisions, including bypassed traffic and denials. Manual resets preserve history.
            </p>
            <ActivityChart buckets={history?.buckets ?? []} range={range} now={now} />
            <h2>Recent decisions</h2>
            <div className="decision-list">
              {!history && <p className="section-help">Loading recent decisions…</p>}
              {history?.requests.length === 0 && (
                <p className="section-help">No request decisions in the past {range}.</p>
              )}
              {history?.requests.map((event) => (
                <div key={event.eventId}>
                  <span className={event.allowed ? 'decision-ok' : 'decision-denied'}>
                    {event.bypassed ? 'Bypassed' : event.allowed ? 'Admitted' : '429 denied'}
                  </span>
                  <span>{stamp(event.asOf)}</span>
                  <small>{event.remaining} left</small>
                </div>
              ))}
            </div>
            {history?.nextCursor && (
              <Button onClick={() => void moreHistory()}>Load older decisions</Button>
            )}
          </>
        ) : (
          <div className="empty-state">
            <CircularProgress />
          </div>
        )}
      </Drawer>
      <Dialog open={!!action} onClose={() => !saving && setAction(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          {action?.kind === 'reset'
            ? 'Reset charged usage'
            : action?.kind === 'bypass'
              ? action.value === 'true'
                ? 'Enable persistent bypass'
                : 'Disable bypass'
              : action?.kind === 'limit'
                ? 'Set base limit'
                : 'Set persistent extra quota'}
        </DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <p className="section-help">
            {action?.kind === 'reset'
              ? 'Starts a new quota epoch. Existing policy and historical activity are preserved.'
              : action?.kind === 'bypass'
                ? 'Bypassed requests remain visible in activity but do not consume quota. This setting has no expiry.'
                : action?.kind === 'extra-quota'
                  ? 'Adds to capacity in every rolling hour. Set to zero to remove it.'
                  : 'The request waits for the data plane to apply the change. Existing charged usage is preserved.'}
          </p>
          {(action?.kind === 'limit' || action?.kind === 'extra-quota') && (
            <TextField
              fullWidth
              autoFocus
              type="number"
              label={action.kind === 'limit' ? 'Base limit' : 'Extra quota'}
              value={action.value}
              onChange={(event) => setAction({ ...action, value: event.target.value })}
              sx={{ mt: 2 }}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={saving} onClick={() => setAction(null)}>
            Cancel
          </Button>
          <Button variant="contained" disabled={saving} onClick={() => void submitAction()}>
            {saving ? 'Applying…' : 'Apply change'}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={!!notice}
        autoHideDuration={6000}
        onClose={() => setNotice('')}
        message={notice}
      />
    </div>
  );
}
