// Mail Collector launcher: runtime check -> deps -> port check -> npm run dev -> open browser
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
process.chdir(projectRoot);

const BACKEND_PORT = Number(process.env.PORT || 8787);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 5173);
const PANEL_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
const HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
const READY_TIMEOUT_MS = 60_000;
const PROBE_INTERVAL_MS = 800;
const HTTP_TIMEOUT_MS = 2_000;
const TCP_TIMEOUT_MS = 1_000;
const MIN_NODE_MAJOR = 18;

const stage = (name, message) => console.log(`[${name}] ${message}`);
const fail = (message) => console.error(`\x1b[31m${message}\x1b[0m`);

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    fail(`检测到 Node.js ${process.version}，低于所需的 v${MIN_NODE_MAJOR}.x。`);
    fail(`请前往 https://nodejs.org/ 升级到最新 LTS 后重试。`);
    process.exit(1);
  }
  stage('runtime', `node ${process.version}`);
}

function spawnInherit(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function ensureDependencies() {
  if (existsSync(path.join(projectRoot, 'node_modules'))) {
    stage('deps', 'node_modules 已存在，跳过 npm install');
    return;
  }
  stage('deps', '首次启动，正在执行 npm install ...');
  const code = await spawnInherit('cmd.exe', ['/c', 'npm', 'install']);
  if (code !== 0) {
    fail(`npm install 失败 (exit code ${code})`);
    process.exit(1);
  }
  stage('deps', 'npm install 完成');
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(val);
    };
    sock.setTimeout(TCP_TIMEOUT_MS);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function httpGet(url, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

async function detectExistingInstance() {
  const [backendListening, frontendListening] = await Promise.all([
    isPortListening(BACKEND_PORT),
    isPortListening(FRONTEND_PORT)
  ]);

  if (!backendListening && !frontendListening) return { state: 'free' };

  if (backendListening) {
    const probe = await httpGet(HEALTH_URL);
    if (probe.ok && probe.status === 200) {
      try {
        const body = JSON.parse(probe.body);
        if (body && body.ok === true) {
          if (frontendListening) return { state: 'existing' };
          return { state: 'busy', reason: `后端 ${BACKEND_PORT} 已在运行，但前端 ${FRONTEND_PORT} 未监听` };
        }
      } catch {
        // not our backend
      }
    }
  }

  const occupied = [
    backendListening ? BACKEND_PORT : null,
    frontendListening ? FRONTEND_PORT : null
  ].filter(Boolean).join(', ');
  return { state: 'busy', reason: `端口 ${occupied} 已被其他程序占用` };
}

function openBrowser(url) {
  // 'start' is a cmd builtin; the empty "" is the window title arg required when target has spaces
  const child = spawn('cmd.exe', ['/c', 'start', '""', url], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true
  });
  child.unref();
}

async function waitForFrontend() {
  const startedAt = Date.now();
  let lastError = '未收到响应';
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    const probe = await httpGet(PANEL_URL);
    if (probe.ok && probe.status >= 200 && probe.status < 300) return;
    lastError = probe.error || `HTTP ${probe.status}`;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  throw new Error(`前端 ${PANEL_URL} 在 ${READY_TIMEOUT_MS / 1000} 秒内未就绪 (最近一次: ${lastError})`);
}

let devProcess = null;
let cleaningUp = false;

function killTree(pid) {
  if (!pid) return;
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {
    // ignore: process may already be gone
  }
}

function cleanup(reason) {
  if (cleaningUp) return;
  cleaningUp = true;
  if (reason) stage('shutdown', reason);
  if (devProcess && devProcess.pid && devProcess.exitCode === null) {
    killTree(devProcess.pid);
  }
}

['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    cleanup(`收到 ${sig}，正在停止前后端 ...`);
    setTimeout(() => process.exit(0), 300);
  });
});
process.on('exit', () => cleanup());

async function main() {
  console.log('================================================');
  console.log('  Mail Collector  一键启动');
  console.log('================================================');

  checkNodeVersion();
  await ensureDependencies();

  stage('ports', `检测端口 ${BACKEND_PORT} / ${FRONTEND_PORT} ...`);
  const detected = await detectExistingInstance();

  if (detected.state === 'existing') {
    stage('ports', '检测到 Mail Collector 已在运行，直接打开面板');
    openBrowser(PANEL_URL);
    stage('open', PANEL_URL);
    return;
  }

  if (detected.state === 'busy') {
    fail(detected.reason);
    fail('请先关闭占用端口的程序后再试。');
    process.exit(2);
  }

  stage('services', '启动 npm run dev (前端 + 后端) ...');
  devProcess = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
    stdio: 'inherit',
    shell: false,
    windowsHide: false
  });

  devProcess.on('exit', (code, signal) => {
    if (!cleaningUp) {
      stage('services', `npm run dev 已退出 (code=${code}, signal=${signal ?? '-'})`);
    }
    process.exit(code ?? 0);
  });

  stage('ready', `等待前端就绪: ${PANEL_URL}`);
  try {
    await waitForFrontend();
    stage('open', `前端就绪，正在打开浏览器 -> ${PANEL_URL}`);
    openBrowser(PANEL_URL);
    console.log('--------------------------------------------------');
    console.log(' 关闭此窗口或按 Ctrl+C 即可同时停止前后端服务');
    console.log('--------------------------------------------------');
  } catch (err) {
    fail(err.message);
    cleanup('前端就绪超时，正在清理 ...');
    process.exit(3);
  }
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
  cleanup('启动器异常退出');
  process.exit(1);
});
