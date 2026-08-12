import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, existsSync, openSync, statSync, writeSync } from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	readdir,
	open as openFile,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

const PROVIDER_ID = "ds4";
const MODEL_ID = "deepseek-v4-flash";
// Keep the historical typo for on-disk lease/state compatibility with older installs.
const MANAGED_BY = "pi-sd4-provider";

const DS4_DIR = join(homedir(), ".pi", "ds4");
const KV_DIR = join(DS4_DIR, "kv");
const SUPPORT_DIR = join(DS4_DIR, "support");
const CLIENT_DIR = join(DS4_DIR, "clients");
const LOCK_DIR = join(DS4_DIR, "lock");
const STATE_FILE = join(DS4_DIR, "server.json");
const AGENT_FILE = join(DS4_DIR, "agent.json");
const LOG_FILE = join(DS4_DIR, "log");
const LEASE_FILE = join(CLIENT_DIR, `${process.pid}.json`);
const BUILD_RECORD_FILE = join(DS4_DIR, "build.json");


// audreyt/pi-ds4 fork: pull the audreyt/ds4 main branch by default. That
// branch carries the merged DwarfStar/upstream runtime, Metal 4 M5 MPP +
// Tensor matmul fast paths, deterministic tool-call ID derivation from
// seeded requests (what makes the seed=42 traces stable end-to-end), and
// optional directional steering for contested-question framing. Override with
// DS4_SUPPORT_REPO / DS4_SUPPORT_BRANCH if you want a different ds4 build.
//
// SUPPORT_PIN is the exact audreyt/ds4 commit this version of pi-ds4 was
// tested against. On every launch, if the local support checkout exists but
// does not match the pin, the extension fetches the pin, hard-resets to it,
// and deletes the cached ds4-server binary so ensureBuilt rebuilds. This is
// what propagates ds4-server fixes to existing installs without a manual
// `rm -rf ~/.pi/ds4/support` dance. Bump this when you ship a new ds4-server
// or ds4-agent fix you want existing users to pick up. Set DS4_SUPPORT_PIN= (empty) to
// disable the pin and freeze the local checkout where it is.
const SUPPORT_REPO = process.env.DS4_SUPPORT_REPO ?? "https://github.com/audreyt/ds4";
const SUPPORT_BRANCH = process.env.DS4_SUPPORT_BRANCH ?? "main";
const SUPPORT_PIN = (process.env.DS4_SUPPORT_PIN ?? "67acbd8103034ff44c588a3893c6dd438f5cf6b0").trim();

const DOWNLOAD_SCRIPT = process.env.DS4_DOWNLOAD_SCRIPT
	? resolve(process.env.DS4_DOWNLOAD_SCRIPT)
	: join(EXTENSION_DIR, "download_model.sh");

const BASE_URL = "http://127.0.0.1:8000";
const API_BASE_URL = `${BASE_URL}/v1`;

// audreyt/ds4 serves /v1/chat/completions, /v1/responses, and /v1/messages.
// DS4_PROTOCOL picks which one Pi talks to; the watchdog and state-file
// `baseUrl` stay at API_BASE_URL because /v1/models is shared across protocols.
type ProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

function selectedProtocol(): ProviderProtocol {
	const raw = process.env.DS4_PROTOCOL?.toLowerCase() ?? "openai";
	switch (raw) {
		case "openai":
		case "openai-completions":
		case "chat":
		case "chat-completions":
			return "openai-completions";
		case "responses":
		case "openai-responses":
			return "openai-responses";
		case "anthropic":
		case "anthropic-messages":
		case "messages":
			return "anthropic-messages";
		default:
			throw new Error(`Invalid DS4_PROTOCOL=${raw}; expected openai, openai-responses, or anthropic`);
	}
}

const PROVIDER_API = selectedProtocol();
const PROVIDER_BASE_URL = PROVIDER_API === "anthropic-messages" ? BASE_URL : API_BASE_URL;

// DS4_CONTEXT_KB sets the server context window in *kilotokens* (the only
// supported knob for context size).
//
//   Default: 100  → 100 000 tokens (the previous conservative default)
//   Common values:
//     128   → 128 k
//     256   → 256 k
//     512   → 512 k
//     1024  → 1 024 000 tokens (full 1 M context of DeepSeek V4 Flash)
//
// When raising DS4_CONTEXT_KB you should normally also raise
// DS4_KV_DISK_SPACE_MB so the on-disk KV cache can hold a full working set
// (e.g. 65536 or higher for 1 M context).
//
// Default KV disk budget is RAM-tiered when DS4_KV_DISK_SPACE_MB is unset:
//   128 GB+  → 65536 MiB (64 GB) — keeps long agent-session prefixes on disk
//              so turns reuse incremental prefill instead of re-reading ~60k+
//              tokens every time (@tjansn reported the 8 GB cap pain on long runs).
//   96–127 GB → 32768 MiB (32 GB)
//   else      → 8192 MiB (legacy 8 GB floor)
//
// The 1 M path (DS4_CONTEXT_KB=1024 + 65536 MiB KV) was measured on a 128 GB M5 Max:
// ≈ 21.3 GB live KV buffers, server reached "listening" successfully.
// On 96 GB machines keep ≤ 256 unless other memory usage is minimal.
const CONTEXT_KB = (process.env.DS4_CONTEXT_KB ?? "100").trim();
const CTX_SIZE = /^\d+$/.test(CONTEXT_KB)
	? String(Number(CONTEXT_KB) * 1000)
	: "100000";

function defaultKvDiskSpaceMb(): string {
	const ramGb = totalmem() / 1_000_000_000;
	if (ramGb >= 128) return "65536";
	if (ramGb >= 96) return "32768";
	return "8192";
}

const KV_DISK_SPACE_MB = process.env.DS4_KV_DISK_SPACE_MB?.trim() || defaultKvDiskSpaceMb();
// Directional steering is opt-in for Headroom128 and other non-calibrated
// weights. The legacy cyberneurova-calibrated uncertainty vector remains
// available in the ds4 checkout, but it is weight-specific: leave FFN/ATTN at
// 0 until a Headroom128 direction is validated. Set DS4_DIR_STEERING_FFN (and
// optionally ATTN) to enable, or point DS4_DIR_STEERING_FILE at a different
// .f32.
//
// When enabled, keep FFN-only for tool-enabled agent runs. Seeded
// OpenClaw/Codex-harness replays showed ffn=-2, attn=-0.5 can over-amplify the
// direction into DSML/tool-call leakage on long 50k+ tool prompts. ffn=-0.75,
// attn=0 is the historical guarded magnitude on the cyberneurova vector.
const STEERING_FILE = process.env.DS4_DIR_STEERING_FILE ?? "dir-steering/out/uncertainty_ablit_imatrix.f32";
const STEERING_FFN = process.env.DS4_DIR_STEERING_FFN ?? "0";
const STEERING_ATTN = process.env.DS4_DIR_STEERING_ATTN ?? "0";
const STEERING_POLICY = process.env.DS4_DIR_STEERING_POLICY ?? "final-answer";
const STEERING_ARGS = STEERING_FILE && (Number(STEERING_FFN) !== 0 || Number(STEERING_ATTN) !== 0)
	? [
		"--dir-steering-file", STEERING_FILE,
		"--dir-steering-ffn", STEERING_FFN,
		"--dir-steering-attn", STEERING_ATTN,
		"--dir-steering-policy", STEERING_POLICY,
	]
	: [];
const AGENT_STEERING_ARGS = STEERING_FILE && (Number(STEERING_FFN) !== 0 || Number(STEERING_ATTN) !== 0)
	? [
		"--dir-steering-file", STEERING_FILE,
		"--dir-steering-ffn", STEERING_FFN,
		"--dir-steering-attn", STEERING_ATTN,
	]
	: [];
const SERVER_ARGS = ["--ctx", CTX_SIZE, "--kv-disk-dir", KV_DIR, "--kv-disk-space-mb", KV_DISK_SPACE_MB, ...STEERING_ARGS];

// DSpark block-speculative decode. Default ON when the Headroom128 support
// GGUF is present in the support checkout (bundled download_model.sh fetches
// it, non-fatally). Set DS4_DSPARK=0 to disable.
const DSPARK_SUPPORT_FILE = "DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf";
function dsparkEnabledArgs(runtimeDir: string): string[] {
	if (process.env.DS4_DSPARK === "0") return [];
	const support = join(runtimeDir, "gguf", DSPARK_SUPPORT_FILE);
	try {
		if (!existsSync(support) || !statSync(support).size) return [];
	} catch {
		return [];
	}
	return ["--dspark", "--mtp", join("gguf", DSPARK_SUPPORT_FILE)];
}

const REPRODUCIBLE = envFlagEnabled(process.env.DS4_REPRODUCIBLE, true);
const REPRODUCIBLE_SEED = REPRODUCIBLE ? parseReproducibleSeed(process.env.DS4_REPRODUCIBLE_SEED) : 42;
const AGENT_TOKENS = process.env.DS4_AGENT_TOKENS?.trim() || "50000";

const HEARTBEAT_MS = 10_000;
const LEASE_TTL_MS = 45_000;
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 30_000;
const STARTUP_LOCK_TIMEOUT_MS = 24 * 60 * 60_000;
const READY_TIMEOUT_MS = Number(process.env.DS4_READY_TIMEOUT_MS ?? 10 * 60_000);
const HTTP_CHECK_TIMEOUT_MS = 1_500;
const SHUTDOWN_GRACE_MS = 60_000;
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_MAX_LINES = 2_000;
const LOG_POLL_MS = 1_000;
const WATCHDOG_POLL_MS = 2_000;
const PROGRESS_NOTIFY_MS = 750;
const PROGRESS_MAX_CHARS = 160;

// pi-ds4 prefers the single Headroom128 GGUF from
// apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128
// (~81 GiB / ~87 GB). The bundled download_model.sh refuses any other quant.
// The historic "q2" label is kept for on-disk lease/state compatibility with
// older installs.
type ModelQuant = "q2";

type ServerState = {
	managedBy: string;
	pid: number;
	baseUrl: string;
	cwd: string;
	binary: string;
	args: string[];
	startedAt: number;
	startedAtIso: string;
	stopping?: boolean;
	stoppingAt?: number;
	stoppingAtIso?: string;
};

type Lease = {
	managedBy: string;
	usesDs4: true;
	pid: number;
	processStart: string;
	cwd: string;
	startedAt: number;
	updatedAt: number;
	updatedAtIso: string;
};

type AgentRunState = {
	managedBy: string;
	pid: number;
	processStart: string;
	cwd: string;
	startedAt: number;
	startedAtIso: string;
};

type StatusCallback = (message: string | undefined) => void;
type RunLoggedOptions = { onStatus?: StatusCallback; progressPrefix?: string };

type LogTui = { terminal: { rows: number }; requestRender: (force?: boolean) => void };
type ForegroundTui = LogTui & { start: () => void; stop: () => void };
type LogTheme = { fg: (color: any, text: string) => string };
type Component = { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void };

const WATCHDOG_SCRIPT_NAME = "ds4-watchdog.sh";
const WATCHDOG_SCRIPT = process.env.DS4_WATCHDOG_SCRIPT
	? resolve(process.env.DS4_WATCHDOG_SCRIPT)
	: join(EXTENSION_DIR, WATCHDOG_SCRIPT_NAME);

let heartbeat: ReturnType<typeof setInterval> | undefined;
let startupPromise: Promise<void> | undefined;
let activeSetupChild: ChildProcess | undefined;
let resolvedRuntimeDir: string | undefined;
let leaseStartedAt = Date.now();
let ownProcessStart: string | undefined;
let leaseActive = false;
let watchdogStarted = false;
let runtimeDisposed = false;
let shuttingDown = false;
let writeSeq = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined || value.trim() === "") return defaultValue;
	return !/^(?:0|false|no|off)$/i.test(value.trim());
}

function parseReproducibleSeed(value: string | undefined): number {
	const raw = value?.trim() || "42";
	if (!/^\d+$/.test(raw)) throw new Error(`DS4_REPRODUCIBLE_SEED must be a positive integer, got ${raw}`);
	const seed = Number(raw);
	if (!Number.isSafeInteger(seed) || seed < 1) {
		throw new Error(`DS4_REPRODUCIBLE_SEED must be a positive safe integer, got ${raw}`);
	}
	return seed;
}

function isProviderPayload(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayloadSeed(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string" && /^-?\d+(?:\.0+)?$/.test(value.trim())) return Math.trunc(Number(value));
	return undefined;
}

function withReproducibleSeed(payload: unknown): unknown | undefined {
	if (!REPRODUCIBLE || !isProviderPayload(payload)) return undefined;
	const payloadSeed = parsePayloadSeed(payload.seed);
	if (payloadSeed !== undefined && payloadSeed >= 1) {
		return payload.seed === payloadSeed ? undefined : { ...payload, seed: payloadSeed };
	}
	return { ...payload, seed: REPRODUCIBLE_SEED };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isLockTimeout(error: unknown): boolean {
	return describeError(error).includes("Timed out waiting for ds4 lifecycle lock");
}

function isPidAlive(pid: unknown): pid is number {
	if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}


function isKey(data: string, key: "escape" | "up" | "down" | "home" | "end" | "pageUp" | "pageDown"): boolean {
	switch (key) {
		case "escape":
			return data === "\x1b";
		case "up":
			return data === "\x1b[A" || data === "\x1bOA";
		case "down":
			return data === "\x1b[B" || data === "\x1bOB";
		case "home":
			return data === "\x1b[H" || data === "\x1bOH" || data === "\x1b[1~";
		case "end":
			return data === "\x1b[F" || data === "\x1bOF" || data === "\x1b[4~";
		case "pageUp":
			return data === "\x1b[5~";
		case "pageDown":
			return data === "\x1b[6~";
	}
}

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

function truncateText(value: string, width: number, ellipsis = "", pad = false): string {
	if (width <= 0) return "";
	let text = stripAnsi(value);
	if (text.length > width) {
		const suffix = ellipsis.length < width ? ellipsis : "";
		text = text.slice(0, width - suffix.length) + suffix;
	}
	return pad ? text + " ".repeat(Math.max(0, width - text.length)) : text;
}

function selectedModelQuant(): ModelQuant {
	const forced = process.env.DS4_MODEL_QUANT?.toLowerCase();
	if (forced && forced !== "q2") {
		throw new Error(
			`DS4_MODEL_QUANT=${forced} not supported; this extension only automates the preferred Headroom128 GGUF (apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128, historic selector q2). Unset DS4_MODEL_QUANT or set it to q2. (To experiment with another GGUF, bypass this extension and run ds4-server directly — see explainer §8.6 C path.)`,
		);
	}

	const ramGb = totalmem() / 1_000_000_000;
	if (ramGb < 96) {
		throw new Error(
			`DeepSeek V4 Flash Headroom128 needs at least 96 GB RAM; detected ${ramGb.toFixed(1)} GB`,
		);
	}
	if (ramGb < 128) {
		const wiredLimitMb = readIogpuWiredLimitMb();
		if (wiredLimitMb < 87_000) {
			throw new Error(
				`Detected ${ramGb.toFixed(1)} GB RAM. On Macs below 128 GB the Metal wired-memory ceiling must be raised first so the ~81 GiB / ~87 GB Headroom128 GGUF fits. Run:\n\n  sudo sysctl iogpu.wired_limit_mb=92000\n\nTo persist across reboots:\n\n  echo 'iogpu.wired_limit_mb=92000' | sudo tee -a /etc/sysctl.conf\n\nThen re-run this command. 128 GB+ Macs do not need this step and can run more apps alongside ds4-server.`,
			);
		}
	}
	return "q2";
}

function readIogpuWiredLimitMb(): number {
	try {
		const out = execSync("sysctl -n iogpu.wired_limit_mb", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return Number.parseInt(out, 10) || 0;
	} catch {
		return 0;
	}
}

async function ensureDirs(): Promise<void> {
	await mkdir(CLIENT_DIR, { recursive: true });
	await mkdir(KV_DIR, { recursive: true });
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	await rename(tmp, file);
}

async function removeFile(file: string): Promise<void> {
	try {
		await unlink(file);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function appendLog(text: string): Promise<void> {
	await mkdir(DS4_DIR, { recursive: true });
	await appendFile(LOG_FILE, text, "utf8");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function readLogTail(): Promise<string[]> {
	try {
		const info = await stat(LOG_FILE);
		if (!info.isFile()) return [`${LOG_FILE} exists but is not a file`];

		const bytes = Math.min(info.size, LOG_TAIL_BYTES);
		const buffer = Buffer.alloc(bytes);
		const file = await openFile(LOG_FILE, "r");
		try {
			await file.read(buffer, 0, bytes, info.size - bytes);
		} finally {
			await file.close();
		}

		let text = stripAnsi(buffer.toString("utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (info.size > bytes) {
			const firstNewline = text.indexOf("\n");
			if (firstNewline >= 0) text = text.slice(firstNewline + 1);
			text = `[showing last ${formatBytes(bytes)} of ${formatBytes(info.size)} from ${LOG_FILE}]\n${text}`;
		}

		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.slice(-LOG_MAX_LINES);
	} catch (error: any) {
		if (error?.code === "ENOENT") return [`No ds4 log yet: ${LOG_FILE}`];
		return [`Failed to read ${LOG_FILE}: ${describeError(error)}`];
	}
}

class Ds4LogViewer implements Component {
	private lines: string[] = [];
	private scrollFromBottom = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private version = 0;
	private cachedWidth = 0;
	private cachedRows = 0;
	private cachedVersion = -1;
	private cachedScroll = -1;
	private cachedLines: string[] = [];

	constructor(
		private tui: LogTui,
		private theme: LogTheme,
		private done: () => void,
	) {
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), LOG_POLL_MS);
		this.timer.unref?.();
	}

	private async refresh(): Promise<void> {
		const wasFollowing = this.scrollFromBottom === 0;
		this.lines = await readLogTail();
		this.version++;
		if (wasFollowing) this.scrollFromBottom = 0;
		this.invalidate();
		this.tui.requestRender();
	}

	private viewportHeight(): number {
		return Math.max(8, Math.min(40, this.tui.terminal.rows - 6));
	}

	private bodyHeight(): number {
		return Math.max(1, this.viewportHeight() - 4);
	}

	private clampScroll(): void {
		this.scrollFromBottom = Math.max(0, Math.min(this.scrollFromBottom, Math.max(0, this.lines.length - this.bodyHeight())));
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.bodyHeight() - 2);
		if (isKey(data, "escape") || data === "q") {
			this.done();
			return;
		}
		if (isKey(data, "up") || data === "k") this.scrollFromBottom++;
		else if (isKey(data, "down") || data === "j") this.scrollFromBottom--;
		else if (isKey(data, "home")) this.scrollFromBottom = this.lines.length;
		else if (isKey(data, "end")) this.scrollFromBottom = 0;
		else if (isKey(data, "pageUp") || data === "b") this.scrollFromBottom += page;
		else if (isKey(data, "pageDown") || data === "f") this.scrollFromBottom -= page;
		else return;

		this.clampScroll();
		this.invalidate();
		this.tui.requestRender();
	}

	private borderLine(left: string, fill: string, right: string, width: number, title?: string): string {
		const innerWidth = Math.max(0, width - 2);
		let inner = this.theme.fg("border", fill.repeat(innerWidth));
		if (title) {
			const rawTitle = truncateText(` ${title} `, innerWidth);
			const fillWidth = Math.max(0, innerWidth - rawTitle.length);
			inner = this.theme.fg("accent", rawTitle) + this.theme.fg("border", fill.repeat(fillWidth));
		}
		return this.theme.fg("border", left) + inner + this.theme.fg("border", right);
	}

	private row(text: string, width: number, color?: (value: string) => string): string {
		const innerWidth = Math.max(0, width - 4);
		const content = truncateText(text.replace(/\t/g, "   "), innerWidth, "", true);
		return this.theme.fg("border", "│") + " " + (color ? color(content) : content) + " " + this.theme.fg("border", "│");
	}

	render(width: number): string[] {
		const height = this.viewportHeight();
		if (
			this.cachedWidth === width &&
			this.cachedRows === height &&
			this.cachedVersion === this.version &&
			this.cachedScroll === this.scrollFromBottom
		) {
			return this.cachedLines;
		}

		this.clampScroll();
		const bodyHeight = this.bodyHeight();
		const start = Math.max(0, this.lines.length - bodyHeight - this.scrollFromBottom);
		const visible = this.lines.slice(start, start + bodyHeight);
		while (visible.length < bodyHeight) visible.unshift("");

		const state = this.scrollFromBottom === 0 ? "live" : `${this.scrollFromBottom} lines up`;
		const title = `ds4 log • ${state}`;
		const help = `↑↓ scroll • Pg page • End live • q/Esc close • ${LOG_FILE}`;
		const lines = [
			this.borderLine("╭", "─", "╮", width, title),
			...visible.map((line) => this.row(line, width)),
			this.row(help, width, (value) => this.theme.fg("dim", value)),
			this.borderLine("╰", "─", "╯", width),
		];

		this.cachedWidth = width;
		this.cachedRows = height;
		this.cachedVersion = this.version;
		this.cachedScroll = this.scrollFromBottom;
		this.cachedLines = lines;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

async function execCapture(command: string, args: string[], timeoutMs = 2_000, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child: ChildProcess;

		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolvePromise(value);
		};

		const timeout = setTimeout(() => {
			try {
				child?.kill("SIGTERM");
			} catch {}
			finish(undefined);
		}, timeoutMs);
		timeout.unref?.();

		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
		} catch {
			finish(undefined);
			return;
		}

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? stdout : stdout || stderr || undefined));
	});
}

async function processArgs(pid: number): Promise<string | undefined> {
	return (await execCapture("ps", ["-p", String(pid), "-o", "args="], 2_000))?.trim();
}

async function processStart(pid: number): Promise<string | undefined> {
	// LC_ALL=C: GNU procps localizes lstart; BSD ps does not. Force a stable
	// locale so the value written into the lease file under one LANG/LC_TIME
	// still compares equal when re-read under another. Mirrors the same fix in
	// ds4-watchdog.sh process_start().
	return (await execCapture("ps", ["-p", String(pid), "-o", "lstart="], 2_000, { ...process.env, LC_ALL: "C" }))?.trim() || undefined;
}

async function getOwnProcessStart(): Promise<string> {
	ownProcessStart ??= (await processStart(process.pid)) ?? "unknown";
	return ownProcessStart;
}

async function isLeaseForLiveProcess(lease: Lease | undefined): Promise<boolean> {
	if (!lease || lease.managedBy !== MANAGED_BY || lease.usesDs4 !== true) return false;
	if (!isPidAlive(lease.pid)) return false;
	if (!lease.processStart) return false;
	const currentStart = await processStart(lease.pid);
	return currentStart === lease.processStart;
}

async function looksLikeDs4Server(pid: number): Promise<boolean> {
	const args = await processArgs(pid);
	return !!args && /(^|[/\s])ds4-server(\s|$)/.test(args);
}

async function findListeningDs4ServerPid(): Promise<number | undefined> {
	const output = await execCapture("lsof", ["-nP", "-tiTCP:8000", "-sTCP:LISTEN"], 2_000);
	for (const line of (output ?? "").split(/\r?\n/)) {
		const pid = Number(line.trim());
		if (Number.isInteger(pid) && isPidAlive(pid) && (await looksLikeDs4Server(pid))) return pid;
	}
	return undefined;
}

async function resolveWatchdogScript(): Promise<string> {
	try {
		await access(WATCHDOG_SCRIPT, constants.F_OK);
		return WATCHDOG_SCRIPT;
	} catch {
		throw new Error(`Cannot find bundled ${WATCHDOG_SCRIPT_NAME} at ${WATCHDOG_SCRIPT}`);
	}
}

async function cleanupLegacyWatchdogStateFiles(): Promise<void> {
	const entries = await readdir(DS4_DIR).catch(() => [] as string[]);
	await Promise.all(
		entries
			.filter((entry) => /^watchdog(?:-\d+)?\.json$/.test(entry))
			.map((entry) => removeFile(join(DS4_DIR, entry)).catch(() => {})),
	);
}

async function cleanupOldNodeWatchdogs(): Promise<void> {
	const output = await execCapture("ps", ["axww", "-o", "pid=,args="], 2_000);
	for (const line of (output ?? "").split(/\r?\n/)) {
		const match = line.trim().match(/^(\d+)\s+(.*)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const args = match[2] ?? "";
		if (pid === process.pid || !args.includes("node -e") || !args.includes("ds4-watchdog")) continue;
		try {
			process.kill(pid, "SIGTERM");
			await appendLog(`[${new Date().toISOString()}] stopped old node ds4-watchdog pid=${pid}\n`);
		} catch {}
	}
	await cleanupLegacyWatchdogStateFiles();
}

async function hasRunningWatchdog(): Promise<boolean> {
	const output = await execCapture("ps", ["axww", "-o", "pid=,args="], 2_000);
	const invocation = `${WATCHDOG_SCRIPT_NAME} ${DS4_DIR}`;
	for (const line of (output ?? "").split(/\r?\n/)) {
		const match = line.trim().match(/^(\d+)\s+(.*)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const args = match[2] ?? "";
		if (pid !== process.pid && args.includes(invocation)) return true;
	}
	return false;
}

async function ensureWatchdog(): Promise<void> {
	if (watchdogStarted) return;
	await mkdir(DS4_DIR, { recursive: true });
	await cleanupOldNodeWatchdogs();
	const watchdogScript = await resolveWatchdogScript();

	if (await hasRunningWatchdog()) {
		watchdogStarted = true;
		return;
	}

	const logFd = openSync(LOG_FILE, "a");
	try {
		const child = spawn("/bin/sh", [watchdogScript, DS4_DIR], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: {
				...process.env,
				DS4_DIR,
				DS4_CLIENT_DIR: CLIENT_DIR,
				DS4_STATE_FILE: STATE_FILE,
				DS4_LOG_FILE: LOG_FILE,
				DS4_BASE_URL: API_BASE_URL,
				DS4_LEASE_TTL_S: String(Math.ceil(LEASE_TTL_MS / 1000)),
				DS4_WATCHDOG_POLL_S: String(Math.max(1, Math.ceil(WATCHDOG_POLL_MS / 1000))),
				DS4_SHUTDOWN_GRACE_S: String(Math.ceil(SHUTDOWN_GRACE_MS / 1000)),
			},
		});
		child.unref();
		watchdogStarted = true;
	} finally {
		closeSync(logFd);
	}
}

async function writeAdoptedServerStateLocked(pid: number): Promise<void> {
	const args = await processArgs(pid);
	const now = Date.now();
	const binary = args?.split(/\s+/, 1)[0] || "ds4-server";
	const state: ServerState = {
		managedBy: MANAGED_BY,
		pid,
		baseUrl: API_BASE_URL,
		cwd: SUPPORT_DIR,
		binary,
		args: args ? [args] : [],
		startedAt: now,
		startedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(STATE_FILE, state);
	await appendLog(`\n[${new Date().toISOString()}] adopted existing ds4-server pid=${pid}\n`);
}

function formatCurlProgress(line: string): string | undefined {
	const fields = line.trim().split(/\s+/);
	if (fields.length < 12) return undefined;
	if (!/^\d+(?:\.\d+)?$/.test(fields[0]) || !/^\d+(?:\.\d+)?$/.test(fields[2])) return undefined;

	const total = fields[1];
	const percent = fields[2];
	const received = fields[3];
	const left = fields[10];
	const speed = fields[11];
	if (!total || !received) return undefined;

	const details = [`${percent}%`];
	if (speed && speed !== "0") details.push(`${speed}/s`);
	if (left && left !== "--:--:--") details.push(`${left} left`);
	return `${received} / ${total} (${details.join(", ")})`;
}

function compactProgressLine(rawLine: string): string | undefined {
	let line = stripAnsi(rawLine)
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!line) return undefined;
	if (/^% Total\b/.test(line) || /^Dload\s+Upload\b/.test(line)) return undefined;

	line = formatCurlProgress(line) ?? line;
	if (line.length > PROGRESS_MAX_CHARS) line = `${line.slice(0, PROGRESS_MAX_CHARS - 1)}…`;
	return line;
}

function createProgressReporter(prefix: string, onStatus?: StatusCallback) {
	let lineBuffer = "";
	let latest: string | undefined;
	let emitted: string | undefined;
	let lastEmit = 0;

	const maybeEmit = (force = false) => {
		if (!onStatus || !latest || latest === emitted) return;
		const now = Date.now();
		if (!force && now - lastEmit < PROGRESS_NOTIFY_MS) return;
		emitted = latest;
		lastEmit = now;
		onStatus(`${prefix}: ${latest}`);
	};

	const processLine = (line: string) => {
		const progress = compactProgressLine(line);
		if (!progress) return;
		latest = progress;
		maybeEmit(false);
	};

	const onChunk = (chunk: Buffer | string) => {
		const text = chunk.toString();
		let start = 0;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (ch !== "\r" && ch !== "\n") continue;
			processLine(lineBuffer + text.slice(start, i));
			lineBuffer = "";
			if (ch === "\r" && text[i + 1] === "\n") i++;
			start = i + 1;
		}
		lineBuffer += text.slice(start);

		// Some progress renderers (notably tqdm / huggingface-cli) write "\r" before
		// the replacement text instead of after it.  If we wait for the next CR we are
		// always one update behind, and if no next update arrives the UI is stuck on
		// the previous human line ("Downloading ...").  Treat the current unterminated
		// buffer as the latest progress too, but keep buffering it for the final line.
		if (lineBuffer) processLine(lineBuffer);

		if (lineBuffer.length > 4096) {
			lineBuffer = "";
		}
	};

	const flush = () => {
		if (lineBuffer) {
			processLine(lineBuffer);
			lineBuffer = "";
		}
		maybeEmit(true);
	};

	return { onChunk, flush };
}

async function runLogged(command: string, args: string[], cwd: string, label: string, options: RunLoggedOptions = {}): Promise<void> {
	if (runtimeDisposed || shuttingDown) throw new Error(`${label} cancelled`);

	await appendLog(`\n[${new Date().toISOString()}] ${label}\n$ ${[command, ...args].map(shellQuote).join(" ")}\n`);

	const logFd = openSync(LOG_FILE, "a");
	const progress = options.progressPrefix ? createProgressReporter(options.progressPrefix, options.onStatus) : undefined;
	let closed = false;
	const writeLogChunk = (chunk: Buffer | string) => {
		if (closed) return;
		try {
			if (typeof chunk === "string") writeSync(logFd, chunk);
			else writeSync(logFd, chunk);
		} catch {}
	};
	const closeLog = () => {
		if (!closed) {
			closed = true;
			closeSync(logFd);
		}
	};

	await new Promise<void>((resolvePromise, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});
		} catch (error) {
			progress?.flush();
			closeLog();
			reject(error);
			return;
		}

		activeSetupChild = child;
		const handleOutput = (chunk: Buffer) => {
			writeLogChunk(chunk);
			progress?.onChunk(chunk);
		};
		child.stdout?.on("data", handleOutput);
		child.stderr?.on("data", handleOutput);

		const finish = (error?: Error) => {
			if (activeSetupChild === child) activeSetupChild = undefined;
			progress?.flush();
			closeLog();
			if (error) reject(error);
			else resolvePromise();
		};

		child.on("error", (error) => finish(error));
		child.on("close", (code, signal) => {
			if (runtimeDisposed || shuttingDown) {
				finish(new Error(`${label} cancelled`));
			} else if (code === 0) {
				finish();
			} else {
				finish(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`}); see ${LOG_FILE}`));
			}
		});
	});
}

function killActiveSetupChild(): void {
	const child = activeSetupChild;
	if (!child?.pid) return;
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
	} catch {}
}

async function isDs4Checkout(dir: string): Promise<boolean> {
	try {
		await Promise.all([
			access(join(dir, "download_model.sh"), constants.F_OK),
			access(join(dir, "Makefile"), constants.F_OK),
			access(join(dir, "ds4_server.c"), constants.F_OK),
		]);
		return true;
	} catch {
		return false;
	}
}

function gitHead(dir: string): string | null {
	try {
		return execSync("git rev-parse HEAD", {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function gitHasLocalChanges(dir: string): boolean {
	try {
		const out = execSync("git status --porcelain", {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

// Bring the local support checkout to SUPPORT_PIN. Skipped when:
//   - SUPPORT_PIN is empty (user disabled pin enforcement),
//   - SUPPORT_DIR is a symlink (dev setup pointing at a working tree),
//   - DS4_SUPPORT_REPO or DS4_SUPPORT_BRANCH is set in env (user wants a
//     different upstream than we ship by default),
//   - HEAD already matches the pin.
// Refuses (throws) if the working tree has uncommitted changes — silently
// `git reset --hard` would clobber the user's in-progress work.
async function syncToSupportPin(dir: string, onStatus?: StatusCallback): Promise<void> {
	if (!SUPPORT_PIN) return;
	if (process.env.DS4_SUPPORT_REPO || process.env.DS4_SUPPORT_BRANCH) return;
	let linkStat;
	try {
		linkStat = await lstat(dir);
	} catch {
		return;
	}
	if (linkStat.isSymbolicLink()) return;
	const head = gitHead(dir);
	if (!head || head === SUPPORT_PIN) return;
	if (gitHasLocalChanges(dir)) {
		throw new Error(
			`${dir} has uncommitted changes; refusing to update to pinned ds4 commit ${SUPPORT_PIN.slice(0, 12)}. ` +
				`Stash/commit those changes, remove the directory, or set DS4_SUPPORT_PIN= to disable the pin.`,
		);
	}
	onStatus?.(`updating ds4 support checkout to ${SUPPORT_PIN.slice(0, 12)}`);
	await runLogged("git", ["fetch", "--depth", "1", "origin", SUPPORT_PIN], dir, "fetch ds4 pin", { onStatus });
	await runLogged("git", ["reset", "--hard", SUPPORT_PIN], dir, "reset ds4 to pin", { onStatus });
	// stale binaries must go so ensureBuilt / ensureAgentBuilt rebuild against the new source
	await Promise.all([
		rm(join(dir, "ds4-server"), { force: true }),
		rm(join(dir, "ds4-agent"), { force: true }),
	]);
}

async function ensureSupportCheckout(onStatus?: StatusCallback): Promise<string> {
	if (!(await isDs4Checkout(SUPPORT_DIR))) {
		try {
			await stat(SUPPORT_DIR);
			throw new Error(`${SUPPORT_DIR} exists but does not look like a ds4 checkout`);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}

		onStatus?.("cloning ds4 support checkout");
		await mkdir(DS4_DIR, { recursive: true });
		await runLogged(
			"git",
			["clone", "--progress", "--branch", SUPPORT_BRANCH, "--single-branch", "--depth", "1", SUPPORT_REPO, SUPPORT_DIR],
			DS4_DIR,
			"clone ds4 support checkout",
			{ onStatus, progressPrefix: "cloning ds4 support checkout" },
		);

		if (!(await isDs4Checkout(SUPPORT_DIR))) {
			throw new Error(`Cloned ${SUPPORT_REPO} but ${SUPPORT_DIR} does not look like a ds4 checkout`);
		}
	}

	await syncToSupportPin(SUPPORT_DIR, onStatus);

	try {
		return await realpath(SUPPORT_DIR);
	} catch {
		return SUPPORT_DIR;
	}
}

async function resolveRuntimeDirLocked(onStatus?: StatusCallback): Promise<string> {
	if (resolvedRuntimeDir) return resolvedRuntimeDir;

	const forced = process.env.DS4_RUNTIME_DIR;
	if (forced) {
		const dir = resolve(forced);
		if (!(await isDs4Checkout(dir))) throw new Error(`DS4_RUNTIME_DIR=${dir} is not a ds4 checkout`);
		resolvedRuntimeDir = dir;
		return dir;
	}

	resolvedRuntimeDir = await ensureSupportCheckout(onStatus);
	return resolvedRuntimeDir;
}

type BuildPlan = {
	/** Stable key recorded in build.json so a later different plan forces clean. */
	key: string;
	/** make argv after the program name, e.g. ["ds4-server"] or ["cuda-spark"]. */
	makeArgs: string[];
	/** Human label for status/log lines. */
	label: string;
	/** Backend family for smoke policy. */
	backend: "metal" | "cuda" | "rocm" | "cpu";
	/** True when the Makefile target builds the whole binary suite (server+agent+...). */
	buildsSuite: boolean;
	/** Optional diagnostic detail (compute cap, override source). */
	detail?: string;
};

type BuildRecord = {
	key: string;
	makeArgs: string[];
	label: string;
	backend: string;
	platform: string;
	pin: string;
	builtAt: string;
	detail?: string;
	smoke?: {
		passedAt: string;
		contentPreview: string;
	};
};

function normalizeCudaArchToken(raw: string): string {
	const t = raw.trim().toLowerCase().replace(/^sm_/, "").replace(/\./g, "");
	if (!t) return "";
	if (/^\d+a?$/.test(t)) return `sm_${t}`;
	return raw.trim();
}

function computeCapToSm(cap: string): string | undefined {
	const m = cap.trim().match(/^(\d+)\.(\d+)(a)?$/i);
	if (!m) return undefined;
	return `sm_${m[1]}${m[2]}${m[3] ? "a" : ""}`;
}

function commandExists(bin: string): boolean {
	try {
		const result = spawnSync("sh", ["-c", `command -v ${shellQuote(bin)} >/dev/null 2>&1`], {
			stdio: "ignore",
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

async function detectNvidiaComputeCaps(): Promise<{ caps: string[]; names: string[]; error?: string }> {
	const capOut = await execCapture(
		"nvidia-smi",
		["--query-gpu=compute_cap", "--format=csv,noheader"],
		5_000,
	);
	const nameOut = await execCapture(
		"nvidia-smi",
		["--query-gpu=name", "--format=csv,noheader"],
		5_000,
	);
	if (capOut === undefined && nameOut === undefined) {
		return { caps: [], names: [], error: "nvidia-smi not available or failed" };
	}
	const caps = (capOut ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const names = (nameOut ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	return { caps, names };
}

function isSparkFamily(cap: string | undefined, name: string | undefined): boolean {
	const sm = cap ? computeCapToSm(cap) : undefined;
	if (sm === "sm_121" || sm === "sm_121a") return true;
	if (name && /gb10|dgx\s*spark|spark/i.test(name)) return true;
	return false;
}

async function resolveBuildPlan(): Promise<BuildPlan> {
	const overrideTarget = process.env.DS4_BUILD_TARGET?.trim();
	if (overrideTarget) {
		const parts = overrideTarget.split(/\s+/).filter(Boolean);
		const backend: BuildPlan["backend"] =
			/strix|rocm/i.test(overrideTarget) ? "rocm"
			: /cpu/i.test(overrideTarget) ? "cpu"
			: process.platform === "darwin" ? "metal"
			: "cuda";
		return {
			key: `override:${parts.join(" ")}`,
			makeArgs: parts,
			label: `override ${parts.join(" ")}`,
			backend,
			buildsSuite: !["ds4-server", "ds4-agent", "ds4", "ds4-bench", "ds4-eval"].includes(parts[0] ?? ""),
			detail: "DS4_BUILD_TARGET",
		};
	}

	const backendForce = process.env.DS4_BACKEND?.trim().toLowerCase();
	if (backendForce === "metal") {
		if (process.platform !== "darwin") {
			throw new Error("DS4_BACKEND=metal requires macOS (Darwin)");
		}
		return {
			key: "metal:ds4-server",
			makeArgs: ["ds4-server"],
			label: "Metal ds4-server",
			backend: "metal",
			buildsSuite: false,
		};
	}
	if (backendForce === "cpu") {
		return {
			key: "cpu",
			makeArgs: ["cpu"],
			label: "CPU-only suite",
			backend: "cpu",
			buildsSuite: true,
			detail: "DS4_BACKEND=cpu",
		};
	}
	if (backendForce === "rocm" || backendForce === "strix-halo") {
		return {
			key: "rocm:strix-halo",
			makeArgs: ["strix-halo"],
			label: "ROCm strix-halo",
			backend: "rocm",
			buildsSuite: true,
			detail: "DS4_BACKEND",
		};
	}

	if (process.platform === "darwin") {
		// Default Darwin path is Metal. Explicit non-metal backends already handled above (cpu)
		// or rejected here.
		if (backendForce && backendForce !== "metal") {
			throw new Error(`DS4_BACKEND=${backendForce} is not supported on macOS; use metal (default) or cpu`);
		}
		return {
			key: "metal:ds4-server",
			makeArgs: ["ds4-server"],
			label: "Metal ds4-server",
			backend: "metal",
			buildsSuite: false,
		};
	}

	// Non-Darwin (and explicit cuda backend).
	if (backendForce === "cuda" || !backendForce) {
		const archOverride = process.env.DS4_CUDA_ARCH?.trim();
		if (archOverride) {
			const arch = normalizeCudaArchToken(archOverride);
			if (arch === "sm_121" || arch === "sm_121a") {
				return {
					key: "cuda:cuda-spark",
					makeArgs: ["cuda-spark"],
					label: "CUDA cuda-spark (sm_121)",
					backend: "cuda",
					buildsSuite: true,
					detail: `DS4_CUDA_ARCH=${archOverride}`,
				};
			}
			if (arch === "native") {
				return {
					key: "cuda:cuda-generic",
					makeArgs: ["cuda-generic"],
					label: "CUDA cuda-generic (native)",
					backend: "cuda",
					buildsSuite: true,
					detail: `DS4_CUDA_ARCH=${archOverride}`,
				};
			}
			return {
				key: `cuda:cuda:${arch}`,
				makeArgs: ["cuda", `CUDA_ARCH=${arch}`],
				label: `CUDA cuda CUDA_ARCH=${arch}`,
				backend: "cuda",
				buildsSuite: true,
				detail: `DS4_CUDA_ARCH=${archOverride}`,
			};
		}

		const { caps, names, error } = await detectNvidiaComputeCaps();
		if (error || caps.length === 0) {
			// ROCm fallback only when no NVIDIA device is visible and hipcc exists.
			if (!backendForce && commandExists("hipcc")) {
				return {
					key: "rocm:strix-halo",
					makeArgs: ["strix-halo"],
					label: "ROCm strix-halo",
					backend: "rocm",
					buildsSuite: true,
					detail: "no NVIDIA GPU; hipcc present",
				};
			}
			if (envFlagEnabled(process.env.DS4_ALLOW_CPU, false)) {
				return {
					key: "cpu",
					makeArgs: ["cpu"],
					label: "CPU-only suite",
					backend: "cpu",
					buildsSuite: true,
					detail: "DS4_ALLOW_CPU=1 (no NVIDIA GPU detected)",
				};
			}
			throw new Error(
				`Cannot select a CUDA build target: ${error ?? "no compute_cap from nvidia-smi"}. ` +
					`Refusing bare make ds4-server on Linux (that path omits CUDA_ARCH and can produce a runnable binary with empty/degenerate generations). ` +
					`Fix: install/driver so nvidia-smi works, or set DS4_CUDA_ARCH=sm_XX, or DS4_BUILD_TARGET=cuda-spark|cuda-generic|strix-halo, or DS4_ALLOW_CPU=1. ` +
					`Available ds4 Makefile targets: make cuda-spark (GB10/sm_121), make cuda CUDA_ARCH=sm_N, make cuda-generic, make strix-halo, make cpu.`,
			);
		}

		const uniqueCaps = [...new Set(caps)];
		if (uniqueCaps.length > 1) {
			throw new Error(
				`Multiple distinct NVIDIA compute capabilities detected (${uniqueCaps.join(", ")}). ` +
					`Set DS4_CUDA_ARCH=sm_XX (or CUDA_VISIBLE_DEVICES to a single GPU) so the build target is unambiguous. ` +
					`Refusing a generic build.`,
			);
		}

		const cap = uniqueCaps[0]!;
		const name = names[0];
		const sm = computeCapToSm(cap);
		if (isSparkFamily(cap, name)) {
			return {
				key: "cuda:cuda-spark",
				makeArgs: ["cuda-spark"],
				label: "CUDA cuda-spark (sm_121)",
				backend: "cuda",
				buildsSuite: true,
				detail: `compute_cap=${cap}${name ? ` name=${name}` : ""}`,
			};
		}
		if (!sm) {
			throw new Error(
				`Unrecognized NVIDIA compute capability "${cap}"${name ? ` (${name})` : ""}. ` +
					`Set DS4_CUDA_ARCH explicitly (e.g. sm_90) or DS4_BUILD_TARGET=cuda-generic if you accept nvcc -arch=native. ` +
					`Refusing bare make ds4-server.`,
			);
		}

		// Known cap → explicit Makefile cuda target. Prefer product aliases when they exist.
		if (sm === "sm_121" || sm === "sm_121a") {
			return {
				key: "cuda:cuda-spark",
				makeArgs: ["cuda-spark"],
				label: "CUDA cuda-spark (sm_121)",
				backend: "cuda",
				buildsSuite: true,
				detail: `compute_cap=${cap}`,
			};
		}

		// cuda-generic (native) only when explicitly allowed — never the silent default.
		if (envFlagEnabled(process.env.DS4_CUDA_ALLOW_NATIVE, false)) {
			return {
				key: "cuda:cuda-generic",
				makeArgs: ["cuda-generic"],
				label: "CUDA cuda-generic (native)",
				backend: "cuda",
				buildsSuite: true,
				detail: `DS4_CUDA_ALLOW_NATIVE=1; detected compute_cap=${cap}`,
			};
		}

		return {
			key: `cuda:cuda:${sm}`,
			makeArgs: ["cuda", `CUDA_ARCH=${sm}`],
			label: `CUDA cuda CUDA_ARCH=${sm}`,
			backend: "cuda",
			buildsSuite: true,
			detail: `compute_cap=${cap}${name ? ` name=${name}` : ""}`,
		};
	}

	throw new Error(
		`Unsupported DS4_BACKEND=${backendForce}. Expected metal, cuda, rocm, strix-halo, or cpu.`,
	);
}

async function readBuildRecord(): Promise<BuildRecord | undefined> {
	return readJson<BuildRecord>(BUILD_RECORD_FILE);
}

async function writeBuildRecord(record: BuildRecord): Promise<void> {
	await writeJsonAtomic(BUILD_RECORD_FILE, record);
}

async function binaryIsExecutable(dir: string, name: string): Promise<boolean> {
	try {
		await access(join(dir, name), constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Post-build generation smoke for non-Darwin backends.
 * Asserts on actual choice message text — not HTTP 200, exit status, or finish_reason.
 * Catches the arch-less CUDA failure mode: server starts, returns a choice, content empty /
 * stuck in thinking / repetition-guard death.
 */
async function smokeTestBuiltServer(runtimeDir: string, onStatus?: StatusCallback): Promise<{ contentPreview: string }> {
	if (envFlagEnabled(process.env.DS4_SKIP_BUILD_SMOKE, false)) {
		await appendLog(`[${new Date().toISOString()}] build smoke skipped (DS4_SKIP_BUILD_SMOKE)\n`);
		return { contentPreview: "(skipped)" };
	}

	const binary = join(runtimeDir, "ds4-server");
	const modelPath = join(runtimeDir, "ds4flash.gguf");
	try {
		await access(modelPath, constants.F_OK);
	} catch {
		throw new Error(`build smoke requires ${modelPath}; model missing`);
	}

	// High ephemeral port so we never collide with the managed :8000 server.
	const port = 18000 + (process.pid % 1000);
	const base = `http://127.0.0.1:${port}`;
	const args = [
		"--host", "127.0.0.1",
		"--port", String(port),
		"--ctx", "2048",
		"--tokens", "32",
		"--nothink",
		"-m", modelPath,
	];

	onStatus?.("smoke-testing built ds4-server (generation quality)");
	await appendLog(
		`\n[${new Date().toISOString()}] build smoke\n$ ${[binary, ...args].map(shellQuote).join(" ")}\n`,
	);

	const logFd = openSync(LOG_FILE, "a");
	let child: ChildProcess;
	try {
		child = spawn(binary, args, {
			cwd: runtimeDir,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
	} catch (error) {
		closeSync(logFd);
		throw error;
	}

	const writeChunk = (chunk: Buffer) => {
		try {
			writeSync(logFd, chunk);
		} catch {}
	};
	child.stdout?.on("data", writeChunk);
	child.stderr?.on("data", writeChunk);

	const killSmoke = async () => {
		if (!child.pid) return;
		try {
			process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
		} catch {}
		const deadline = Date.now() + 8_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null || !isPidAlive(child.pid)) break;
			await sleep(200);
		}
		if (child.pid && isPidAlive(child.pid)) {
			try {
				process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
			} catch {}
		}
		try {
			closeSync(logFd);
		} catch {}
	};

	try {
		// Wait until /v1/models answers.
		const readyDeadline = Date.now() + 180_000;
		let ready = false;
		while (Date.now() < readyDeadline) {
			if (child.exitCode !== null) {
				throw new Error(`smoke ds4-server exited early code=${child.exitCode}; see ${LOG_FILE}`);
			}
			try {
				const controller = new AbortController();
				const t = setTimeout(() => controller.abort(), 2_000);
				const res = await fetch(`${base}/v1/models`, { signal: controller.signal });
				clearTimeout(t);
				if (res.ok) {
					ready = true;
					break;
				}
			} catch {
				// not ready yet
			}
			await sleep(1_000);
		}
		if (!ready) {
			throw new Error(`smoke ds4-server did not become ready on ${base}; see ${LOG_FILE}`);
		}

		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 120_000);
		let body: unknown;
		try {
			const res = await fetch(`${base}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					// deepseek-chat selects non-thinking mode so final text lands in message.content
					// (thinking mode can leave content empty while only reasoning fills — which is
					// exactly the failure signature we must not mistake for a good build).
					model: "deepseek-chat",
					messages: [
						{
							role: "user",
							content: "Reply with exactly these two words and nothing else: smoke ok",
						},
					],
					max_tokens: 32,
					temperature: 0,
					seed: 42,
					think: false,
				}),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`smoke chat/completions HTTP ${res.status}: ${text.slice(0, 400)}`);
			}
			body = await res.json();
		} finally {
			clearTimeout(t);
		}

		const content = extractChoiceContent(body);
		const finish = extractChoiceFinishReason(body);

		// Assertions on ACTUAL generated text — the failure mode that burned a night
		// returned HTTP-success choices with empty content / stuck thinking.
		if (!content) {
			throw new Error(
				`build smoke FAILED: empty choices[0].message.content (finish_reason=${finish}). ` +
					`This is the classic wrong-CUDA-arch failure mode: the binary starts and answers HTTP, ` +
					`but generation is degenerate. Rebuild with make cuda-spark (GB10/sm_121) or ` +
					`make cuda CUDA_ARCH=sm_XX matching nvidia-smi compute_cap. See ${LOG_FILE}`,
			);
		}
		if (content.length < 2) {
			throw new Error(
				`build smoke FAILED: content too short (${JSON.stringify(content)}). See ${LOG_FILE}`,
			);
		}
		// Detect pure-repetition sludge (ngram death) with no alphabetic substance.
		const alpha = content.replace(/[^\p{L}\p{N}]+/gu, "");
		if (alpha.length < 2) {
			throw new Error(
				`build smoke FAILED: content has no letters/digits (${JSON.stringify(content.slice(0, 80))}). See ${LOG_FILE}`,
			);
		}

		await appendLog(
			`[${new Date().toISOString()}] build smoke PASS content=${JSON.stringify(content.slice(0, 120))}\n`,
		);
		return { contentPreview: content.slice(0, 120) };
	} finally {
		await killSmoke();
	}
}

function extractChoiceContent(body: unknown): string {
	if (!body || typeof body !== "object") return "";
	if (!("choices" in body) || !Array.isArray(body.choices) || body.choices.length === 0) return "";
	const choice0 = body.choices[0];
	if (!choice0 || typeof choice0 !== "object") return "";
	if (!("message" in choice0) || !choice0.message || typeof choice0.message !== "object") return "";
	const message = choice0.message;
	if (!("content" in message)) return "";
	return typeof message.content === "string" ? message.content.trim() : "";
}

function extractChoiceFinishReason(body: unknown): string {
	if (!body || typeof body !== "object") return "n/a";
	if (!("choices" in body) || !Array.isArray(body.choices) || body.choices.length === 0) return "n/a";
	const choice0 = body.choices[0];
	if (!choice0 || typeof choice0 !== "object") return "n/a";
	if (!("finish_reason" in choice0)) return "n/a";
	return choice0.finish_reason == null ? "n/a" : String(choice0.finish_reason);
}

async function ensureBinariesBuilt(runtimeDir: string, wantAgent: boolean, onStatus?: StatusCallback): Promise<void> {
	const plan = await resolveBuildPlan();
	const record = await readBuildRecord();
	const serverOk = await binaryIsExecutable(runtimeDir, "ds4-server");
	const agentOk = !wantAgent || (await binaryIsExecutable(runtimeDir, "ds4-agent"));
	const pin = SUPPORT_PIN || "(unpinned)";
	const planMatches = record?.key === plan.key && record?.pin === pin;

	// Bring-your-own checkout: never clobber a user-supplied binary tree.
	if (process.env.DS4_RUNTIME_DIR) {
		if (serverOk && agentOk) return;
		// Fall through to build only the missing pieces with the selected plan.
	}

	// Existing Metal installs predate build.json — adopt without rebuild.
	if (serverOk && agentOk && plan.backend === "metal" && !record) {
		await writeBuildRecord({
			key: plan.key,
			makeArgs: plan.makeArgs,
			label: plan.label,
			backend: plan.backend,
			platform: process.platform,
			pin,
			builtAt: new Date().toISOString(),
			detail: "adopted pre-existing Metal binary",
		});
		return;
	}

	if (serverOk && agentOk && planMatches) {
		return;
	}

	// Metal: only agent missing, server already matches plan.
	if (
		serverOk &&
		planMatches &&
		wantAgent &&
		plan.backend === "metal" &&
		!(await binaryIsExecutable(runtimeDir, "ds4-agent"))
	) {
		onStatus?.("building Metal ds4-agent");
		await runLogged("make", ["ds4-agent"], runtimeDir, "build Metal ds4-agent", {
			onStatus,
			progressPrefix: "building Metal ds4-agent",
		});
		if (!(await binaryIsExecutable(runtimeDir, "ds4-agent"))) {
			throw new Error(`build finished but ${join(runtimeDir, "ds4-agent")} is missing or not executable`);
		}
		return;
	}

	// Force clean when retargeting or when a non-Metal binary has no trusted record
	// (legacy bare `make ds4-server` CUDA installs).
	const needsClean =
		Boolean(record && record.key !== plan.key) ||
		Boolean(record && record.pin !== pin) ||
		(serverOk && !record && plan.backend !== "metal") ||
		(serverOk && record && !planMatches);

	if (needsClean) {
		onStatus?.(`make clean (build plan changed: ${record?.key ?? "unknown/generic"} → ${plan.key})`);
		await runLogged("make", ["clean"], runtimeDir, "make clean before retarget", { onStatus });
		await Promise.all([
			rm(join(runtimeDir, "ds4-server"), { force: true }),
			rm(join(runtimeDir, "ds4-agent"), { force: true }),
		]);
	}

	const detail = plan.detail ? ` (${plan.detail})` : "";
	onStatus?.(`building ${plan.label}${detail}`);
	await runLogged("make", plan.makeArgs, runtimeDir, `build ${plan.label}`, {
		onStatus,
		progressPrefix: `building ${plan.label}`,
	});

	// Suite targets already build agent; single-target metal path may need a second invoke.
	if (wantAgent && plan.backend === "metal" && !(await binaryIsExecutable(runtimeDir, "ds4-agent"))) {
		onStatus?.("building Metal ds4-agent");
		await runLogged("make", ["ds4-agent"], runtimeDir, "build Metal ds4-agent", {
			onStatus,
			progressPrefix: "building Metal ds4-agent",
		});
	}

	if (!(await binaryIsExecutable(runtimeDir, "ds4-server"))) {
		throw new Error(`build finished but ${join(runtimeDir, "ds4-server")} is missing or not executable`);
	}
	if (wantAgent && !(await binaryIsExecutable(runtimeDir, "ds4-agent"))) {
		throw new Error(`build finished but ${join(runtimeDir, "ds4-agent")} is missing or not executable`);
	}

	// Smoke requires weights; ensureModel runs after ensureBuilt. Defer non-metal smoke to
	// ensureRuntimeReady once the GGUF is present (see ensureBuildSmokeAfterModel).
	await writeBuildRecord({
		key: plan.key,
		makeArgs: plan.makeArgs,
		label: plan.label,
		backend: plan.backend,
		platform: process.platform,
		pin,
		builtAt: new Date().toISOString(),
		detail: plan.detail,
	});
}

async function ensureBuilt(runtimeDir: string, onStatus?: StatusCallback): Promise<void> {
	await ensureBinariesBuilt(runtimeDir, false, onStatus);
}

async function ensureAgentBuilt(runtimeDir: string, onStatus?: StatusCallback): Promise<void> {
	await ensureBinariesBuilt(runtimeDir, true, onStatus);
}

/** Run generation smoke once weights exist; required for cuda/rocm/cpu new builds. */
async function ensureBuildSmokeAfterModel(runtimeDir: string, onStatus?: StatusCallback): Promise<void> {
	const record = await readBuildRecord();
	if (!record) return;
	if (record.backend === "metal") return; // Metal path is the long-validated primary; skip heavy reload.
	if (record.smoke?.passedAt && record.pin === (SUPPORT_PIN || "(unpinned)") && record.key) {
		// Already smoked this plan+pin.
		if (await binaryIsExecutable(runtimeDir, "ds4-server")) return;
	}
	try {
		const { contentPreview } = await smokeTestBuiltServer(runtimeDir, onStatus);
		await writeBuildRecord({
			...record,
			smoke: { passedAt: new Date().toISOString(), contentPreview },
		});
	} catch (error) {
		// Bad binary must not remain cached for the next launch to treat as success.
		await Promise.all([
			rm(join(runtimeDir, "ds4-server"), { force: true }),
			rm(join(runtimeDir, "ds4-agent"), { force: true }),
		]);
		await removeFile(BUILD_RECORD_FILE);
		throw error;
	}
}


function selectedAgentThinkingArgs(): string[] {
	const raw = process.env.DS4_AGENT_THINK?.trim().toLowerCase();
	if (!raw || raw === "on" || raw === "true" || raw === "think") return ["--think"];
	if (raw === "off" || raw === "false" || raw === "none" || raw === "nothink") return ["--nothink"];
	if (raw === "max" || raw === "think-max" || raw === "xhigh") return ["--think-max"];
	throw new Error("DS4_AGENT_THINK must be one of think, off, none, max, or think-max");
}

function selectedAgentTraceFile(): string | undefined {
	const raw = process.env.DS4_AGENT_TRACE?.trim();
	if (!raw || !envFlagEnabled(raw, false)) return undefined;
	if (/^(?:1|true|yes|on)$/i.test(raw)) return join(DS4_DIR, "agent-trace.jsonl");
	return resolve(raw);
}

function buildAgentArgs(initialPrompt: string): string[] {
	const args = [
		"--ctx", CTX_SIZE,
		"--tokens", AGENT_TOKENS,
		...selectedAgentThinkingArgs(),
		...AGENT_STEERING_ARGS,
	];
	const traceFile = selectedAgentTraceFile();
	if (REPRODUCIBLE) args.push("--seed", String(REPRODUCIBLE_SEED));
	if (process.env.DS4_AGENT_SYSTEM) args.push("--system", process.env.DS4_AGENT_SYSTEM);
	if (traceFile) args.push("--trace", traceFile);
	if (initialPrompt.trim()) args.push("--prompt", initialPrompt.trim());
	return args;
}

async function ensureModel(runtimeDir: string, onStatus?: StatusCallback): Promise<void> {
	const quant = selectedModelQuant();
	onStatus?.(`ensuring ${quant} model (preferred Headroom128 abliterated 0731)`);
	// audreyt/pi-ds4 fork: shadow the antirez/ds4 download_model.sh with our
	// own copy that fetches the preferred Headroom128 GGUF from
	// apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128. Idempotent.
	await runLogged(DOWNLOAD_SCRIPT, [quant], runtimeDir, `download ${quant} model`, {
		onStatus,
		progressPrefix: `downloading ${quant} model`,
	});
}

async function ensureRuntimeReadyLocked(onStatus?: StatusCallback): Promise<string> {
	const runtimeDir = await resolveRuntimeDirLocked(onStatus);
	if (runtimeDisposed || shuttingDown) return runtimeDir;
	await ensureBuilt(runtimeDir, onStatus);
	if (runtimeDisposed || shuttingDown) return runtimeDir;
	await ensureModel(runtimeDir, onStatus);
	if (runtimeDisposed || shuttingDown) return runtimeDir;
	await ensureBuildSmokeAfterModel(runtimeDir, onStatus);
	return runtimeDir;
}

async function ensureAgentRuntimeReady(onStatus?: StatusCallback): Promise<string> {
	return withLock(async () => {
		const runtimeDir = await resolveRuntimeDirLocked(onStatus);
		if (runtimeDisposed || shuttingDown) return runtimeDir;
		if (!process.env.DS4_AGENT_BINARY) await ensureAgentBuilt(runtimeDir, onStatus);
		if (runtimeDisposed || shuttingDown) return runtimeDir;
		await ensureModel(runtimeDir, onStatus);
		if (runtimeDisposed || shuttingDown) return runtimeDir;
		await ensureBuildSmokeAfterModel(runtimeDir, onStatus);
		return runtimeDir;
	}, STARTUP_LOCK_TIMEOUT_MS, true);
}

async function isLockStale(): Promise<boolean> {
	const owner = await readJson<{ pid?: number; processStart?: string }>(join(LOCK_DIR, "owner.json"));
	if (owner?.pid) {
		if (!isPidAlive(owner.pid)) return true;
		if (owner.processStart) {
			const currentStart = await processStart(owner.pid);
			if (currentStart && currentStart !== owner.processStart) return true;
		}
	}

	try {
		const info = await stat(LOCK_DIR);
		return Date.now() - info.mtimeMs > LOCK_STALE_MS;
	} catch {
		return true;
	}
}

async function withLock<T>(fn: () => Promise<T>, timeoutMs = LOCK_TIMEOUT_MS, abortOnDispose = false): Promise<T> {
	await mkdir(DS4_DIR, { recursive: true });
	const started = Date.now();

	while (true) {
		if (abortOnDispose && (runtimeDisposed || shuttingDown)) throw new Error("ds4 startup cancelled");
		try {
			await mkdir(LOCK_DIR);
			await writeJsonAtomic(join(LOCK_DIR, "owner.json"), {
				managedBy: MANAGED_BY,
				pid: process.pid,
				processStart: await getOwnProcessStart(),
				createdAt: Date.now(),
			});
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			if (await isLockStale()) {
				await rm(LOCK_DIR, { recursive: true, force: true });
				continue;
			}
			if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
				throw new Error(`Timed out waiting for ds4 lifecycle lock at ${LOCK_DIR}`);
			}
			await sleep(100 + Math.floor(Math.random() * 150));
		}
	}

	try {
		return await fn();
	} finally {
		await rm(LOCK_DIR, { recursive: true, force: true });
	}
}

async function touchLease(): Promise<void> {
	const now = Date.now();
	const lease: Lease = {
		managedBy: MANAGED_BY,
		usesDs4: true,
		pid: process.pid,
		processStart: await getOwnProcessStart(),
		cwd: process.cwd(),
		startedAt: leaseStartedAt,
		updatedAt: now,
		updatedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(LEASE_FILE, lease);
}

function startHeartbeat(): void {
	if (heartbeat) clearInterval(heartbeat);
	heartbeat = setInterval(() => {
		void touchLease().catch(() => {});
	}, HEARTBEAT_MS);
	heartbeat.unref?.();
}

function stopHeartbeat(): void {
	if (heartbeat) {
		clearInterval(heartbeat);
		heartbeat = undefined;
	}
}

async function pruneLeases(): Promise<void> {
	await mkdir(CLIENT_DIR, { recursive: true });
	const entries = await readdir(CLIENT_DIR).catch(() => [] as string[]);
	const now = Date.now();

	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = join(CLIENT_DIR, entry);
		const [lease, info] = await Promise.all([readJson<Lease>(file), stat(file).catch(() => undefined)]);
		const staleByAge = !info || now - info.mtimeMs > LEASE_TTL_MS;
		const staleByProcess = !(await isLeaseForLiveProcess(lease));
		if (staleByAge || staleByProcess) await removeFile(file);
	}
}

async function readActiveLeases(): Promise<Lease[]> {
	await mkdir(CLIENT_DIR, { recursive: true });
	const entries = await readdir(CLIENT_DIR).catch(() => [] as string[]);
	const leases: Lease[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const lease = await readJson<Lease>(join(CLIENT_DIR, entry));
		if (lease && (await isLeaseForLiveProcess(lease))) leases.push(lease);
	}
	return leases;
}

async function activateLease(): Promise<void> {
	await ensureDirs();
	await touchLease();
	leaseActive = true;
	await pruneLeases();
	await ensureWatchdog();
	startHeartbeat();
}

async function removeOwnLease(): Promise<void> {
	await removeFile(LEASE_FILE);
	leaseActive = false;
}

async function readState(): Promise<ServerState | undefined> {
	return readJson<ServerState>(STATE_FILE);
}

async function clearState(): Promise<void> {
	await removeFile(STATE_FILE);
}

async function readActiveAgentState(): Promise<AgentRunState | undefined> {
	const state = await readJson<AgentRunState>(AGENT_FILE);
	if (!state || state.managedBy !== MANAGED_BY) {
		if (state) await removeFile(AGENT_FILE);
		return undefined;
	}
	if (!isPidAlive(state.pid)) {
		await removeFile(AGENT_FILE);
		return undefined;
	}
	const currentStart = await processStart(state.pid);
	if (!state.processStart || currentStart !== state.processStart) {
		await removeFile(AGENT_FILE);
		return undefined;
	}
	return state;
}

async function writeAgentRunState(): Promise<void> {
	const now = Date.now();
	await writeJsonAtomic(AGENT_FILE, {
		managedBy: MANAGED_BY,
		pid: process.pid,
		processStart: await getOwnProcessStart(),
		cwd: process.cwd(),
		startedAt: now,
		startedAtIso: new Date(now).toISOString(),
	} satisfies AgentRunState);
}

async function clearOwnAgentRunState(): Promise<void> {
	const state = await readJson<AgentRunState>(AGENT_FILE);
	if (!state) return;
	if (state.pid === process.pid && state.processStart === (await getOwnProcessStart())) {
		await removeFile(AGENT_FILE);
	}
}

async function checkHttpReady(): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), HTTP_CHECK_TIMEOUT_MS);
	try {
		const response = await fetch(`${API_BASE_URL}/models`, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function serverHasClients(pid: number): Promise<boolean> {
	const output = await execCapture("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED"], 2_000);
	return (output ?? "").trim().split(/\r?\n/).length > 1;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await sleep(500);
	}
	return !isPidAlive(pid);
}

async function waitForServerReady(onStatus?: StatusCallback): Promise<void> {
	const started = Date.now();
	let lastStatus = 0;

	while (Date.now() - started < READY_TIMEOUT_MS) {
		if (runtimeDisposed || shuttingDown) return;
		if (await checkHttpReady()) return;

		const state = await readState();
		if (state?.pid && !isPidAlive(state.pid)) {
			throw new Error(`ds4-server exited before becoming ready; see ${LOG_FILE}`);
		}

		if (Date.now() - lastStatus > 10_000) {
			const elapsed = Math.round((Date.now() - started) / 1000);
			onStatus?.(`ds4-server starting (${elapsed}s)`);
			lastStatus = Date.now();
		}
		await sleep(1_000);
	}

	throw new Error(`Timed out waiting for ds4-server at ${API_BASE_URL}; see ${LOG_FILE}`);
}

async function stopManagedServerForAgent(onStatus?: StatusCallback): Promise<void> {
	await withLock(async () => {
		await pruneLeases();

		const ownStart = await getOwnProcessStart();
		const activeAgent = await readActiveAgentState();
		if (activeAgent && (activeAgent.pid !== process.pid || activeAgent.processStart !== ownStart)) {
			throw new Error(`ds4-agent is already running in pi process ${activeAgent.pid}; wait for it to exit before starting another copy.`);
		}

		const state = await readState();
		const statePid = state?.pid && isPidAlive(state.pid) && (await looksLikeDs4Server(state.pid)) ? state.pid : undefined;
		const listeningPid = await findListeningDs4ServerPid();
		const httpReady = await checkHttpReady();
		const serverPid = statePid ?? listeningPid;

		if (!serverPid) {
			if (httpReady) {
				throw new Error(
					`Something is already answering at ${API_BASE_URL}, but pi-ds4 could not identify it as a managed ds4-server. ` +
						`Stop it before running /ds4-agent.`,
				);
			}
			if (state?.pid) await clearState();
			stopHeartbeat();
			await removeOwnLease();
			await writeAgentRunState();
			return;
		}

		if (listeningPid && (!statePid || listeningPid !== statePid)) {
			throw new Error(
				`A ds4-server is already listening on ${API_BASE_URL} as pid ${listeningPid}, but this pi session does not own it. ` +
					`Stop that server before running /ds4-agent so the native agent can load the model safely.`,
			);
		}

		const otherLeases = (await readActiveLeases()).filter(
			(lease) => lease.pid !== process.pid || lease.processStart !== ownStart,
		);
		if (otherLeases.length > 0) {
			throw new Error(
				`ds4-server is in use by ${otherLeases.length} other pi process${otherLeases.length === 1 ? "" : "es"}; ` +
					`close those sessions before running /ds4-agent.`,
			);
		}

		if (await serverHasClients(serverPid)) {
			throw new Error(`ds4-server pid ${serverPid} still has active HTTP clients; run /ds4-agent after those requests finish.`);
		}

		onStatus?.("stopping ds4-server before ds4-agent");
		stopHeartbeat();
		await removeOwnLease();

		const now = Date.now();
		await writeJsonAtomic(STATE_FILE, {
			managedBy: MANAGED_BY,
			pid: serverPid,
			baseUrl: API_BASE_URL,
			cwd: state?.cwd ?? SUPPORT_DIR,
			binary: state?.binary ?? "ds4-server",
			args: state?.args ?? [],
			startedAt: state?.startedAt ?? now,
			startedAtIso: state?.startedAtIso ?? new Date(now).toISOString(),
			stopping: true,
			stoppingAt: now,
			stoppingAtIso: new Date(now).toISOString(),
		} satisfies ServerState);
		await appendLog(`\n[${new Date().toISOString()}] stop ds4-server before ds4-agent pid=${serverPid}\n`);

		try {
			process.kill(serverPid, "SIGTERM");
		} catch (error: any) {
			if (error?.code !== "ESRCH") throw error;
		}

		if (!(await waitForPidExit(serverPid, SHUTDOWN_GRACE_MS))) {
			await appendLog(`[${new Date().toISOString()}] ds4-server pid=${serverPid} still alive; sending SIGKILL\n`);
			try {
				process.kill(serverPid, "SIGKILL");
			} catch {}
			if (!(await waitForPidExit(serverPid, 5_000))) {
				throw new Error(`ds4-server pid ${serverPid} did not exit; see ${LOG_FILE}`);
			}
		}

		await clearState();
		await writeAgentRunState();
	}, LOCK_TIMEOUT_MS);
}

async function startServerLocked(runtimeDir: string): Promise<void> {
	const binary = process.env.DS4_SERVER_BINARY ?? join(runtimeDir, "ds4-server");
	try {
		await access(binary, constants.X_OK);
	} catch {
		throw new Error(`Cannot execute ds4-server at ${binary}`);
	}

	const serverArgs = [...SERVER_ARGS, ...dsparkEnabledArgs(runtimeDir)];
	await appendLog(`\n[${new Date().toISOString()}] start ds4-server\n$ ${[binary, ...serverArgs].map(shellQuote).join(" ")}\n`);
	const logFd = openSync(LOG_FILE, "a");
	let childPid: number | undefined;
	try {
		const child = spawn(binary, serverArgs, {
			cwd: runtimeDir,
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
		});
		child.unref();
		childPid = child.pid;
	} finally {
		closeSync(logFd);
	}

	if (!childPid) throw new Error("Failed to start ds4-server: no child PID");

	const now = Date.now();
	const state: ServerState = {
		managedBy: MANAGED_BY,
		pid: childPid,
		baseUrl: API_BASE_URL,
		cwd: runtimeDir,
		binary,
		args: serverArgs,
		startedAt: now,
		startedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(STATE_FILE, state);
}

async function ensureServerManagedInner(onStatus?: StatusCallback): Promise<void> {
	if (runtimeDisposed || shuttingDown) return;
	let stoppingPid: number | undefined;

	await withLock(async () => {
		const activeAgent = await readActiveAgentState();
		if (activeAgent) {
			throw new Error(`ds4-agent is running in pi process ${activeAgent.pid}; wait for it to exit before starting ds4-server`);
		}
		let runtimeDir = await resolveRuntimeDirLocked(onStatus);
		await activateLease();
		if (runtimeDisposed || shuttingDown) return;
		await touchLease();
		await pruneLeases();

		const state = await readState();
		if (state?.pid && isPidAlive(state.pid) && (await looksLikeDs4Server(state.pid))) {
			if (state.stopping) stoppingPid = state.pid;
			return;
		}

		if (state?.pid) await clearState();
		if (await checkHttpReady()) {
			const pid = await findListeningDs4ServerPid();
			if (pid) await writeAdoptedServerStateLocked(pid);
			return;
		}
		if (runtimeDisposed || shuttingDown) return;

		runtimeDir = await ensureRuntimeReadyLocked(onStatus);
		if (runtimeDisposed || shuttingDown) return;

		onStatus?.("starting ds4-server");
		await startServerLocked(runtimeDir);
	}, STARTUP_LOCK_TIMEOUT_MS, true);

	if (runtimeDisposed || shuttingDown) return;

	if (stoppingPid) {
		onStatus?.("waiting for previous ds4-server shutdown");
		if (!(await waitForPidExit(stoppingPid, SHUTDOWN_GRACE_MS))) {
			throw new Error(`Previous ds4-server pid ${stoppingPid} did not exit`);
		}
		await withLock(async () => {
			const state = await readState();
			if (state?.pid === stoppingPid && !isPidAlive(stoppingPid)) await clearState();
		}, LOCK_TIMEOUT_MS);
		return ensureServerManagedInner(onStatus);
	}

	await waitForServerReady(onStatus);
}

function ensureServerManaged(onStatus?: StatusCallback): Promise<void> {
	if (!startupPromise) {
		startupPromise = ensureServerManagedInner(onStatus).finally(() => {
			startupPromise = undefined;
		});
	}
	return startupPromise;
}

async function stopServerIfUnused(): Promise<void> {
	// The watchdog owns lease refcounting and server shutdown.  Keep /quit fast:
	// removing our lease is enough for it to stop ds4-server when nobody else is using it.
	await removeOwnLease();
}

type AgentExit = { status: number | null; signal: NodeJS.Signals | null; error?: string };

function runAgentInForeground(tui: ForegroundTui, binary: string, args: string[], runtimeDir: string): AgentExit {
	tui.stop();
	try {
		process.stdout.write("\x1b[2J\x1b[H");
		process.stdout.write("ds4-agent is taking over this terminal. Type /quit inside ds4-agent to return to pi.\n\n");
		const result = spawnSync(binary, args, {
			cwd: runtimeDir,
			stdio: "inherit",
			env: process.env,
		});
		return {
			status: result.status,
			signal: result.signal,
			error: result.error ? describeError(result.error) : undefined,
		};
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

async function launchDs4Agent(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/ds4-agent requires an interactive terminal", "error");
		return;
	}

	await ctx.waitForIdle();

	let lastNotification: string | undefined;
	const notifyStatus: StatusCallback = (message) => {
		if (!message || message === lastNotification) return;
		lastNotification = message;
		ctx.ui.notify(message, "info");
	};

	let agentRunMarked = false;
	try {
		notifyStatus("preparing ds4-agent");
		const runtimeDir = await ensureAgentRuntimeReady(notifyStatus);
		const binary = process.env.DS4_AGENT_BINARY ? resolve(process.env.DS4_AGENT_BINARY) : join(runtimeDir, "ds4-agent");
		try {
			await access(binary, constants.X_OK);
		} catch {
			throw new Error(`Cannot execute ds4-agent at ${binary}`);
		}

		await stopManagedServerForAgent(notifyStatus);
		agentRunMarked = true;
		const agentArgs = buildAgentArgs(args);

		const exit = await ctx.ui.custom<AgentExit>((tui, _theme, _keybindings, done) => {
			const result = runAgentInForeground(tui as ForegroundTui, binary, agentArgs, runtimeDir);
			done(result);
			return { render: () => [], invalidate: () => {} };
		});

		if (exit.error) {
			ctx.ui.notify(`ds4-agent failed: ${exit.error}`, "error");
		} else if (exit.signal) {
			ctx.ui.notify(`ds4-agent exited with signal ${exit.signal}`, "warning");
		} else if (exit.status && exit.status !== 0) {
			ctx.ui.notify(`ds4-agent exited with status ${exit.status}`, "warning");
		} else {
			ctx.ui.notify("returned from ds4-agent", "info");
		}
	} catch (error) {
		ctx.ui.notify(`ds4-agent launch failed: ${describeError(error)}`, "error");
	} finally {
		if (agentRunMarked) {
			try {
				await clearOwnAgentRunState();
			} catch (error) {
				ctx.ui.notify(`ds4-agent cleanup failed: ${describeError(error)}`, "warning");
			}
		}
	}
}

function registerDs4Command(pi: ExtensionAPI): void {
	pi.registerCommand("ds4", {
		description: "Show the live ds4-server log",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`ds4 log: ${LOG_FILE}`, "info");
				return;
			}

			let viewer: Ds4LogViewer | undefined;
			try {
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						viewer = new Ds4LogViewer(tui, theme, done);
						return viewer;
					},
					{
						overlay: true,
						overlayOptions: {
							width: "90%",
							minWidth: 60,
							maxHeight: "85%",
							anchor: "center",
							margin: 1,
						},
					},
				);
			} finally {
				viewer?.dispose();
			}
		},
	});
}

function registerDs4AgentCommand(pi: ExtensionAPI): void {
	pi.registerCommand("ds4-agent", {
		description: "Launch the native ds4-agent in this terminal",
		handler: launchDs4Agent,
	});
}

function registerDs4Provider(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "ds4.c local",
		baseUrl: PROVIDER_BASE_URL,
		api: PROVIDER_API,
		apiKey: "dsv4-local",
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
			...(PROVIDER_API === "anthropic-messages" ? { supportsEagerToolInputStreaming: false } : {}),
		},
		models: [
			{
				id: MODEL_ID,
				name: "DeepSeek V4 Flash (ds4.c local)",
				reasoning: true,
				thinkingLevelMap: {
					// ds4-server exposes only NONE, HIGH, and MAX. Null keeps pi
					// from presenting intermediate labels that all collapse to HIGH.
					off: "none",
					minimal: null,
					low: null,
					medium: null,
					high: "high",
					xhigh: null,
					max: "max",
				},
				input: ["text"],
				contextWindow: Number(CTX_SIZE) || 100000,
				maxTokens: 384000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	} as any);
}

export default function (pi: ExtensionAPI) {
	runtimeDisposed = false;
	shuttingDown = false;
	leaseStartedAt = Date.now();
	leaseActive = false;
	watchdogStarted = false;
	startupPromise = undefined;
	activeSetupChild = undefined;
	resolvedRuntimeDir = undefined;

	registerDs4Provider(pi);
	registerDs4Command(pi);
	registerDs4AgentCommand(pi);

	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID || ctx.model?.id !== MODEL_ID) return;
		const seededPayload = withReproducibleSeed(event.payload);

		const alreadyReady = await checkHttpReady();
		let lastNotification: string | undefined;
		const notifyStatus: StatusCallback | undefined = alreadyReady
			? undefined
			: (message) => {
					if (!message || message === lastNotification) return;
					if (/^ds4-server starting \(\d+s\)$/.test(message)) return;
					lastNotification = message;
					ctx.ui.notify(message, "info");
				};

		try {
			notifyStatus?.("preparing ds4-server");
			await ensureServerManaged(notifyStatus);
			if (!alreadyReady) ctx.ui.notify("ds4-server ready", "info");
		} catch (error) {
			ctx.ui.notify(`ds4-server startup failed: ${describeError(error)}`, "error");
			throw error;
		}

		return seededPayload;
	});

	pi.on("session_shutdown", async (event, ctx) => {
		runtimeDisposed = true;
		stopHeartbeat();
		killActiveSetupChild();

		try {
			if (startupPromise) await Promise.race([startupPromise.catch(() => {}), sleep(5_000)]);
		} catch {}

		// Session switches and /reload immediately create another extension instance
		// in the same pi process. Keep the lease for those hand-offs.
		if (event.reason !== "quit") return;

		shuttingDown = true;
		try {
			await stopServerIfUnused();
		} catch (error) {
			if (!isLockTimeout(error)) ctx.ui.notify(`ds4-server shutdown failed: ${describeError(error)}`, "error");
		}
	});
}
