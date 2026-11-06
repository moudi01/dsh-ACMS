// Fork of @deepseek-ai/dsh-subagent-codex 0.2.1-rc.5 (MIT).
// Durable thread lifecycle; original permission/failure adapter preserved.
import { createRequire } from "node:module";
import { settleRunResult, subprocessRunHandle } from "@deepseek-ai/dsh-subagent";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
//#region lib/types/wire.js
/**
* Codex app-server protocol adapter, verified against 0.166.0. The shared JSON-RPC
* transport owns framing and request correlation; this module owns only the
* product methods, current thread/turn association, unattended approval
* responses, and terminal-answer selection.
*
* @module @deepseek-ai/dsh-subagent-codex/wire
*/
const THREAD_PERMISSION_PARAMS = {
	"acms-workspace": { approvalPolicy: "never", sandbox: "workspace-write" },
	"acms-review": { approvalPolicy: "never", sandbox: "workspace-write" },
	never: { approvalPolicy: "never" },
	"approve-for-me": {
		approvalPolicy: "on-request",
		approvalsReviewer: "auto_review",
		sandbox: "workspace-write"
	},
	"dangerously-bypass-approvals-and-sandbox": {
		approvalPolicy: "never",
		sandbox: "danger-full-access"
	}
};
function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`subagent-codex: app-server returned invalid ${label}`);
	return value;
}
function string(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`subagent-codex: app-server returned invalid ${label}`);
	return value;
}
function unattendedDecision(params) {
	const available = params.availableDecisions;
	if (available === void 0 || available === null) return "decline";
	if (Array.isArray(available)) {
		if (available.includes("cancel")) return "cancel";
		if (available.includes("decline")) return "decline";
	}
	throw new Error("subagent-codex: app-server offered no unattended approval decision");
}
function numericHttpStatus(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535 ? value : void 0;
}
function objectFailureInfo(value) {
	const keys = Object.keys(value);
	const category = keys[0];
	if (keys.length !== 1 || category === void 0) return { category: "unknown" };
	const detail = value[category];
	if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return { category: "unknown" };
	const fields = detail;
	switch (category) {
		case "httpConnectionFailed":
		case "responseStreamConnectionFailed":
		case "responseStreamDisconnected":
		case "responseTooManyFailedAttempts": {
			const httpStatus = numericHttpStatus(fields.httpStatusCode);
			return httpStatus === void 0 ? { category: "transport" } : {
				category: "transport",
				httpStatus
			};
		}
		case "activeTurnNotSteerable": return { category: "product-error" };
		default: return { category: "unknown" };
	}
}
function failureInfo(turn) {
	if (turn.status !== "failed") return { category: "unknown" };
	const error = turn.error;
	if (error === null || typeof error !== "object" || Array.isArray(error)) return { category: "unknown" };
	const info = error.codexErrorInfo;
	if (typeof info === "string") switch (info) {
		case "contextWindowExceeded": return {
			category: "limit",
			maxTokens: true
		};
		case "sessionBudgetExceeded":
		case "usageLimitExceeded": return { category: "limit" };
		case "serverOverloaded":
		case "internalServerError": return { category: "service" };
		case "cyberPolicy":
		case "misalignmentPolicyViolation":
		case "unauthorized": return { category: "access-policy" };
		case "badRequest":
		case "threadRollbackFailed":
		case "other": return { category: "product-error" };
		case "sandboxError": return {
			category: "access-policy",
			sandboxFailure: true
		};
		default: return { category: "unknown" };
	}
	return info !== null && typeof info === "object" && !Array.isArray(info) ? objectFailureInfo(info) : { category: "unknown" };
}
function unattendedDiagnostic(mode, request, decision, reason) {
	return `Codex unattended decision (mode: ${mode}; request: ${request}; decision: ${decision}): ${reason}`;
}
function thrown$1(value) {
	/* v8 ignore next -- typed protocol and stream failures reject with Error. */
	return value instanceof Error ? value : new Error(String(value));
}
function abortError(signal) {
	return signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error(`subagent-codex: app-server request aborted: ${String(signal.reason)}`);
}
async function raceAbort(pending, signal) {
	if (signal.aborted) {
		pending.catch(() => {});
		throw abortError(signal);
	}
	let rejectAbort;
	const aborted = new Promise((_resolve, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => {
		rejectAbort(abortError(signal));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
/**
* One app-server connection and its single persistent thread/turn.
*
* The class deliberately exposes no generic request surface. Supporting
* another product method must first become part of the provider contract.
*/
var CodexAppServerWire = class {
	input;
	permissionMode;
	model;
	transport;
	fatal = Promise.withResolvers();
	threadId;
	turnId;
	pendingTurnId;
	turnCompleted;
	earlyTurnNotifications = [];
	earlyThreadNotifications = [];
	lastFinalAnswer;
	lastPartialAnswer;
	lastUnphasedAnswer;
	diagnostic;
	failure;
	diagnosticOrder = 0;
	observationOrder = 0;
	pendingDiagnostic;
	inputEnded = false;
	terminalObserved = false;
	closed = false;
	constructor(input, output, permissionMode, model, store, options = {}) {
		this.options = options;
		this.store = store;
		this.input = input;
		this.permissionMode = permissionMode;
		this.model = model;
		this.transport = new JsonRpcLineTransport(input, output);
		this.fatal.promise.catch(() => {});
		this.transport.onRequest((method, params) => this.handleServerRequest(method, params));
		this.transport.onNotification((method, params) => {
			try {
				const notificationThread = params?.threadId ?? params?.thread?.id;
				if (!this.threadId && notificationThread) {
					this.earlyThreadNotifications.push({ method, params });
					return;
				}
				if (this.threadId && notificationThread && notificationThread !== this.threadId) return;
				this.store.record(method, params);
				this.options.onNotification?.(method, params);
				this.handleNotification(method, params);
			} catch (error) {
				this.fail(thrown$1(error));
			}
		});
		this.input.on("error", this.onInputError);
		this.input.on("end", this.onInputEnd);
		output.on("error", this.onOutputError);
	}
	/** Start reading app-server frames. */
	start() {
		this.transport.start();
	}
	/**
	* Whether protocol output ended before a terminal turn notification.
	* @returns `true` only for an early protocol close without a terminal turn.
	*/
	endedBeforeTerminal() {
		return this.inputEnded && !this.terminalObserved;
	}
	/**
	* Perform the required app-server initialize/initialized handshake.
	* @param signal - unpublished-start cancellation.
	*/
	async initialize(signal) {
		object(await this.guarded(this.transport.request("initialize", {
			clientInfo: {
				name: "deepseek-harness",
				title: "DeepSeek Harness",
				version: "0.0.1"
			},
			capabilities: {
				experimentalApi: false,
				requestAttestation: false
			}
		}, signal), signal), "initialize response");
		this.transport.notify("initialized");
		await this.guarded(this.transport.flush(), signal);
	}
	/**
	* Create the run's persistent thread and retain its identity.
	* @param cwd - selected child working directory.
	* @param signal - unpublished-start cancellation.
	*/
	async startThread(cwd, signal) {
    const previous = this.store.summary.threadId;
    const method = previous ? "thread/resume" : "thread/start";
    const params = {
      cwd, ...(previous ? { threadId: previous } : { ephemeral: false }),
      model: this.model, ...THREAD_PERMISSION_PARAMS[this.permissionMode],
      ...(this.permissionMode.startsWith('acms-') ? { config: { 'features.multi_agent': false, 'sandbox_workspace_write.writable_roots': [] } } : {})
    };
    this.store.record("provider/threadOpening", { method, threadId: previous ?? null });
    const response = object(await this.guarded(this.transport.request(method, params, signal), signal), method + " response");
    const thread = object(response.thread, method + " thread");
    const id = string(thread.id, method + " thread id");
    if (thread.ephemeral === true) throw new Error("codex-runtime: server returned an ephemeral thread");
    if (previous && id !== previous) throw new Error("codex-runtime: resume returned a different thread id");
    this.threadId = id;
    for (const notification of this.earlyThreadNotifications.splice(0)) {
      const notificationThread = notification.params?.threadId ?? notification.params?.thread?.id;
      if (notificationThread !== id) continue;
      this.store.record(notification.method, notification.params);
      this.handleNotification(notification.method, notification.params);
    }
    this.store.update({ threadId: id, model: response.model ?? this.model, cwd, resumed: Boolean(previous) });
    await this.store.publish(signal);
    this.store.record("provider/threadReady", { threadId: id, resumed: Boolean(previous) });
  }
	/**
	* Submit the one text-only task and wait for this thread/turn's authoritative
	* terminal notification.
	* @param texts - already validated task text blocks.
	* @param signal - local cancellation for the published run.
	* @returns the shared subagent result.
	*/
	async runTurn(texts, signal) {
		const completion = Promise.withResolvers();
		this.turnCompleted = completion;
		const threadId = this.threadId;
		try {
			const turn = object(object(await this.guarded(this.transport.request("turn/start", {
				threadId,
				...(this.options.reasoningEffort ? { effort: this.options.reasoningEffort } : {}),
				input: texts.map((text) => ({
					type: "text",
					text,
					text_elements: []
				}))
			}, signal), signal), "turn/start response").turn, "turn/start turn");
			this.commitTurnId(string(turn.id, "turn/start turn id"));
      if (this.store.summary.currentTurn !== this.turnId) {
        this.store.update({ status: "running", lastStatus: "running", currentTurn: this.turnId, turnId: this.turnId,
          turns: (this.store.summary.turns ?? 0) + 1, startedAt: new Date().toISOString(), toolCalls: 0, turnTokenUsage: null });
      }
      this.store.record("provider/turnAccepted", { threadId: this.threadId, turnId: this.turnId });
      this.options.onAccepted?.();
		} catch (error) {
			this.recordFailure({
				stage: "turn-start",
				category: "unknown"
			});
			throw error;
		}
		let completed;
		let terminal;
		try {
			completed = await this.guarded(completion.promise, signal);
			terminal = object(completed.params.turn, "turn/completed turn");
		} catch (error) {
			this.recordFailure({
				stage: "turn",
				category: "unknown"
			});
			throw error;
		}
		const status = terminal.status;
		if (status !== "completed") {
			const parsed = failureInfo(terminal);
			this.recordFailure(parsed.httpStatus === void 0 ? {
				stage: "turn",
				category: parsed.category
			} : {
				stage: "turn",
				category: parsed.category,
				httpStatus: parsed.httpStatus
			});
			if (parsed.sandboxFailure) this.recordDiagnostic("sandbox execution", "failed", "Codex reported a sandbox failure", completed.order);
			if (parsed.maxTokens) return {
				output: this.collectOutput(),
				stopReason: "max-tokens"
			};
			const detail = status === "failed" ? `: ${parsed.category}` : "";
			throw new Error(`subagent-codex: Codex turn ended with status ${String(status)}${detail}`);
		}
		const output = this.collectOutput();
		if (output.length === 0) {
			this.recordFailure({
				stage: "turn",
				category: "invalid-result"
			});
			throw new Error("subagent-codex: Codex completed without an answer");
		}
		return {
			output,
			stopReason: "completed"
		};
	}
	/**
	* Best-effort remote cancellation. Local settlement and process teardown
	* remain authoritative when the child no longer accepts protocol requests.
	*/
	interrupt() {
		if (this.threadId === void 0 || this.turnId === void 0 || this.closed) return;
		this.transport.request("turn/interrupt", {
			threadId: this.threadId,
			turnId: this.turnId
		}).catch(() => {});
	}
	/**
	* The best non-commentary answer observed so far, preserving exact bytes:
	* the latest `final_answer`, else the latest `partial_answer`, else the
	* latest nullable-phase message.
	* @returns the selected text block, if any.
	*/
	collectOutput() {
		const selected = this.lastFinalAnswer ?? this.lastPartialAnswer ?? this.lastUnphasedAnswer;
		return selected !== void 0 && selected.trim().length > 0 ? [{
			type: "text",
			text: selected
		}] : [];
	}
	/**
	* The latest safe unattended permission fact observed for this run.
	* @returns provider-authored diagnostic text, when one was observed.
	*/
	collectDiagnostic() {
		return this.diagnostic;
	}
	/**
	* The structured failure fact observed for this published turn.
	* Call only after a non-completed return or rejection from {@link runTurn}.
	* @returns the fixed stage/category pair and optional HTTP status.
	*/
	collectFailure() {
		return this.failure;
	}
	/** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
	async steer(text, signal) {
		if (this.closed || this.terminalObserved || !this.threadId || !this.turnId) throw new Error('Codex 当前没有可接收消息的执行轮次');
		const expectedTurnId = this.turnId;
		const result = object(await this.guarded(this.transport.request('turn/steer', {
			threadId: this.threadId, expectedTurnId, input: [{ type: 'text', text, text_elements: [] }]
		}, signal), signal), 'turn/steer response');
		if (result.turnId !== expectedTurnId) throw new Error('Codex 消息回执的轮次不匹配');
		return result.turnId;
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.input.off("end", this.onInputEnd);
		this.transport.close();
	}
	async guarded(pending, signal) {
		return raceAbort(Promise.race([this.fatal.promise, pending]), signal);
	}
	fail(error) {
		this.fatal.reject(error);
	}
	onInputError = (error) => {
		this.fail(error);
	};
	onOutputError = (error) => {
		this.fail(error);
	};
	onInputEnd = () => {
		this.inputEnded = true;
		this.fail(/* @__PURE__ */ new Error("subagent-codex: app-server protocol stream closed"));
	};
	observePendingTurnId(id) {
		if (this.turnCompleted === void 0) throw new Error("subagent-codex: app-server referenced a turn before turn/start");
		if (this.pendingTurnId !== void 0 && this.pendingTurnId !== id) throw new Error("subagent-codex: app-server referenced conflicting turns");
		this.pendingTurnId = id;
	}
	commitTurnId(id) {
		if (this.pendingTurnId !== void 0 && this.pendingTurnId !== id) throw new Error("subagent-codex: turn/start response did not match the active turn");
		this.turnId = id;
		const pendingDiagnostic = this.pendingDiagnostic;
		this.pendingDiagnostic = void 0;
		if (pendingDiagnostic !== void 0) this.recordDiagnostic(pendingDiagnostic.request, pendingDiagnostic.decision, pendingDiagnostic.reason, pendingDiagnostic.order);
		const notifications = this.earlyTurnNotifications.splice(0);
		for (const notification of notifications) this.handleNotification(notification.method, notification.params, notification.order);
	}
	/**
	* Validate the request's thread and turn association.
	* @returns `true` when the matching turn is still provisional, so the caller
	* defers its diagnostic until `commitTurnId()`.
	*/
	validateRunIds(params, nullableTurn = false) {
		if (params.threadId !== this.threadId) throw new Error("subagent-codex: app-server request referenced another thread");
		if (nullableTurn && params.turnId === null) return false;
		const id = string(params.turnId, "server request turn id");
		if (this.turnId === void 0) {
			this.observePendingTurnId(id);
			return true;
		}
		if (id !== this.turnId) throw new Error("subagent-codex: app-server request referenced another turn");
		return false;
	}
	recordRequestDiagnostic(provisional, request, decision, reason) {
		const order = this.nextObservationOrder();
		if (provisional) {
			this.pendingDiagnostic = {
				order,
				request,
				decision,
				reason
			};
			return;
		}
		this.recordDiagnostic(request, decision, reason, order);
	}
	recordDiagnostic(request, decision, reason, order = this.nextObservationOrder()) {
		if (order < this.diagnosticOrder) return;
		this.diagnosticOrder = order;
		this.diagnostic = unattendedDiagnostic(this.permissionMode, request, decision, reason);
	}
	recordFailure(facts) {
		this.failure = facts;
	}
	nextObservationOrder() {
		this.observationOrder += 1;
		return this.observationOrder;
	}
	recordDeclinedItem(item, order) {
		if (item.type === "commandExecution" && item.status === "declined") {
			this.recordDiagnostic("command execution", "declined", "Codex declined the command under the selected permission mode", order);
			return true;
		}
		if (item.type === "fileChange" && item.status === "declined") {
			this.recordDiagnostic("file change", "declined", "Codex declined the file change under the selected permission mode", order);
			return true;
		}
		return false;
	}
	handleServerRequest(method, params) {
		try {
      this.validateRunIds(params, method === "mcpServer/elicitation/request");
      this.store.record("provider/serverRequest", { method, ...params });
			switch (method) {
				case "item/commandExecution/requestApproval": {
					const provisional = this.validateRunIds(params);
					const decision = unattendedDecision(params);
					this.recordRequestDiagnostic(provisional, "command approval", decision === "cancel" ? "cancelled" : "declined", "the provider does not grant interactive approval");
					return Promise.resolve({ decision });
				}
				case "item/fileChange/requestApproval": {
					const provisional = this.validateRunIds(params);
					const decision = unattendedDecision(params);
					this.recordRequestDiagnostic(provisional, "file approval", decision === "cancel" ? "cancelled" : "declined", "the provider does not grant interactive approval");
					return Promise.resolve({ decision });
				}
				case "item/permissions/requestApproval":
					this.recordRequestDiagnostic(this.validateRunIds(params), "permission grant", "denied", "the provider grants no additional turn permissions");
					return Promise.resolve({
						permissions: {},
						scope: "turn"
					});
				case "item/tool/requestUserInput":
					this.recordRequestDiagnostic(this.validateRunIds(params), "user input", "empty response", "the provider does not collect interactive answers");
					return Promise.resolve({ answers: {} });
				case "mcpServer/elicitation/request":
					this.recordRequestDiagnostic(this.validateRunIds(params, true), "MCP elicitation", "declined", "the provider does not collect interactive MCP input");
					return Promise.resolve({
						action: "decline",
						content: null,
						_meta: null
					});
				default: throw new Error(`subagent-codex: unsupported app-server request ${JSON.stringify(method)}`);
			}
		} catch (error) {
			const normalized = thrown$1(error);
			this.fail(normalized);
			return Promise.reject(normalized);
		}
	}
	handleNotification(method, params, order) {
		if (method === "turn/started") {
			if (string(params.threadId, "turn/started thread id") !== this.threadId) return;
			const turn = object(params.turn, "turn/started turn");
			if (this.turnCompleted !== void 0 && this.turnId === void 0) this.observePendingTurnId(string(turn.id, "turn/started turn id"));
			return;
		}
		if (method === "item/completed") {
			if (string(params.threadId, "item/completed thread id") !== this.threadId) return;
			const id = string(params.turnId, "item/completed turn id");
			if (this.turnId === void 0) {
				if (this.turnCompleted !== void 0) {
					this.observePendingTurnId(id);
					this.earlyTurnNotifications.push({
						method,
						params,
						order: this.nextObservationOrder()
					});
				}
				return;
			}
			if (id !== this.turnId) return;
			const item = object(params.item, "item/completed item");
			if (this.recordDeclinedItem(item, order)) return;
			if (item.type !== "agentMessage") return;
			const text = typeof item.text === "string" ? item.text : (() => {
				throw new Error("subagent-codex: app-server returned an invalid agent message");
			})();
			if (item.phase === "final_answer") this.lastFinalAnswer = text;
			else if (item.phase === "partial_answer") this.lastPartialAnswer = text;
			else if (item.phase === null) this.lastUnphasedAnswer = text;
			else if (item.phase !== "commentary") throw new Error(`subagent-codex: app-server returned an unknown agent message phase ${JSON.stringify(item.phase)}`);
			return;
		}
		if (method !== "turn/completed") return;
		if (string(params.threadId, "turn/completed thread id") !== this.threadId) return;
		const turn = object(params.turn, "turn/completed turn");
		const id = string(turn.id, "turn/completed turn id");
		const turnCompleted = this.turnCompleted;
		if (turnCompleted === void 0) return;
		if (this.turnId === void 0) {
			this.observePendingTurnId(id);
			this.earlyTurnNotifications.push({
				method,
				params,
				order: this.nextObservationOrder()
			});
			return;
		}
		if (id !== this.turnId) return;
		this.terminalObserved = true;
		if (![
			"completed",
			"interrupted",
			"failed"
		].includes(String(turn.status))) throw new Error(`subagent-codex: app-server returned invalid terminal turn status ${String(turn.status)}`);
		turnCompleted.resolve({
			params,
			order: order ?? this.nextObservationOrder()
		});
	}
};
//#endregion
//#region lib/types/run.js
/**
* One-shot Codex child lifecycle: spawn the real app-server through the
* subprocess seam, publish only after initialization and persistent thread
* creation, flatten post-publication failures, and dispose to whole-range
* quiescence.
*
* @module @deepseek-ai/dsh-subagent-codex/run
*/
const codexPackageJsonPath = createRequire(import.meta.url).resolve("@openai/codex/package.json");
const codexPackageManifest = JSON.parse(readFileSync(codexPackageJsonPath, "utf8"));
/** Absolute package-local JavaScript wrapper selected by the package manifest. */
const CODEX_PACKAGE_BIN = resolve(dirname(codexPackageJsonPath), codexPackageManifest.bin.codex);
function failureDiagnostic(facts) {
	const fields = [
		"product: Codex",
		`stage: ${facts.stage}`,
		`category: ${facts.category}`
	];
	if (facts.httpStatus !== void 0) fields.push(`HTTP status: ${facts.httpStatus}`);
	const processFields = [["exit code", facts.outcome?.exitCode], ["signal", facts.outcome?.signal]];
	for (const [label, value] of processFields) if (value !== null && value !== void 0) fields.push(`${label}: ${value}`);
	return `Product subagent failure (${fields.join("; ")})`;
}
var CodexRunFailure = class extends Error {
	facts;
	constructor(facts, cause) {
		super(`subagent-codex: ${failureDiagnostic(facts)}`, cause === void 0 ? void 0 : { cause });
		this.facts = facts;
		this.name = "CodexRunFailure";
	}
};
/**
* Hide an unpublished Host failure behind fixed safe startup facts.
* @param cause Original Host failure retained for internal diagnostics.
* @returns A startup failure whose message contains only fixed safe facts.
*/
function codexStartupFailure(cause) {
	return new CodexRunFailure({
		stage: "initialize",
		category: "unknown"
	}, cause);
}
/**
* Fixed package-local app-server command, independent of the host `PATH`.
* @returns Node, the official wrapper, and the fixed app-server arguments.
*/
function codexAppServerArgv(bin = CODEX_PACKAGE_BIN) {
	return [
		process.execPath,
		bin,
		"app-server",
		"--stdio"
	];
}
function thrown(value) {
	/* v8 ignore next -- typed subprocess/wire failures reject with Error. */
	return value instanceof Error ? value : new Error(String(value));
}
/**
* Validate and preserve the one-shot task before crossing the process boundary.
* @param prompt - task content accepted from the shared subagent service.
* @returns the exact non-empty text block sequence.
*/
function textTask(prompt) {
	if (prompt.length === 0) throw new Error("subagent-codex: the one-shot task must contain only text blocks");
	const texts = [];
	for (const block of prompt) {
		if (block.type !== "text") throw new Error("subagent-codex: the one-shot task must contain only text blocks");
		texts.push(block.text);
	}
	if (texts.every((text) => text.trim().length === 0)) throw new Error("subagent-codex: the one-shot task must not be empty");
	return texts;
}
/**
* Close the private wire, terminate the managed range, and wait for the
* subprocess owner to prove it is quiescent.
* @param wire - private app-server protocol connection.
* @param child - shared-service handle that owns the managed range.
*/
async function disposeCodexChild(wire, child) {
	wire.close();
	let outcome;
	child.done.then((value) => {
		outcome = value;
	}, () => {});
	try {
		child.stdin?.end();
	} catch {}
	child.terminate();
	try {
		await child.waitForExit();
	} catch (error) {
		throw new CodexRunFailure({
			stage: "teardown",
			category: "unknown",
			outcome
		}, thrown(error));
	}
	await child.done.catch(() => {});
}
/**
* Start the real `codex app-server --stdio` child and publish its one-shot run.
* @param request - resolved shared subagent request.
* @param spec - Workspace, environment, process service, and diagnostic policy.
* @returns the published run after initialization and persistent thread opening.
*/
async function startCodexRun(request, spec) {
	const texts = textTask(request.prompt);
	if (request.signal.aborted) throw new Error("subagent-codex: request was aborted before app-server startup");
	let child;
	try {
		child = spec.spawn({
			argv: spec.argv ?? codexAppServerArgv(spec.codexBin),
			cwd: spec.cwd,
			stdio: {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe"
			},
			graceMs: spec.disposeGraceMs,
			env: spec.env
		});
	} catch (error) {
		throw new CodexRunFailure({
			stage: "initialize",
			category: "unknown"
		}, thrown(error));
	}
	const wire = new CodexAppServerWire(child.stdout, child.stdin, spec.permissionMode, spec.model, spec.store, spec);
	const onStderr = (chunk) => {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		try {
			writeFileSync(process.stderr.fd, bytes);
		} catch {}
	};
	const onStderrError = () => {};
	child.stderr?.on("data", onStderr);
	child.stderr?.on("error", onStderrError);
	const disposeProcess = async () => {
		try {
			await disposeCodexChild(wire, child);
			await new Promise((resolve) => {
				setImmediate(resolve);
			});
		} finally {
			child.stderr?.off("data", onStderr);
			child.stderr?.off("error", onStderrError);
		}
	};
	let processFailureFacts;
	const processFailure = child.done.then((outcome) => {
		processFailureFacts = {
			stage: "process",
			category: "process",
			outcome
		};
		throw new CodexRunFailure(processFailureFacts);
	}, (error) => {
		processFailureFacts = {
			stage: "process",
			category: "unknown"
		};
		throw new CodexRunFailure(processFailureFacts, thrown(error));
	});
	processFailure.catch(() => {});
	const runAbort = new AbortController();
	const requestCancel = () => {
		if (runAbort.signal.aborted) return;
		runAbort.abort(/* @__PURE__ */ new Error("subagent-codex: run cancelled locally"));
		wire.interrupt();
	};
	const onAbort = () => {
		requestCancel();
	};
	request.signal.addEventListener("abort", onAbort, { once: true });
	let startupStage = "initialize";
  const startupSignal = AbortSignal.any([request.signal, AbortSignal.timeout(spec.startupTimeoutMs)]);
	try {
		wire.start();
		await Promise.race([wire.initialize(startupSignal), processFailure]);
		startupStage = spec.store.summary.threadId ? "thread-resume" : "thread-start";
		await Promise.race([wire.startThread(spec.cwd, startupSignal), processFailure]);
	} catch (error) {
		request.signal.removeEventListener("abort", onAbort);
		const cancelledBeforeCleanup = runAbort.signal.aborted;
		if (!(error instanceof CodexRunFailure) && !cancelledBeforeCleanup) await new Promise((resolve) => {
			setImmediate(resolve);
		});
		const failure = new CodexRunFailure({
			stage: startupStage,
			category: "unknown",
			outcome: error instanceof CodexRunFailure ? error.facts.outcome : processFailureFacts?.outcome
		}, thrown(error));
		if (startupSignal.aborted && !request.signal.aborted) failure.timedOut = true;
		try {
			await disposeProcess();
		} catch (disposeError) {
			const cleanupFailure = thrown(disposeError);
			throw new AggregateError([failure, cleanupFailure], `${failure.message}; ${cleanupFailure.message}`);
		}
		if (cancelledBeforeCleanup) throw new Error("subagent-codex: request was aborted before run publication");
		try {
			request.signal.throwIfAborted();
		} catch {
			throw new Error("subagent-codex: request was aborted before run publication");
		}
		throw failure;
	}
	const collectOutput = () => wire.collectOutput();
	let diagnostic;
	const recordFailureDiagnostic = (facts) => {
		spec.failure = facts;
		const failure = failureDiagnostic(facts);
		const permission = wire.collectDiagnostic();
		diagnostic = permission === void 0 ? failure : `${failure}\n${permission}`;
		return diagnostic;
	};
	const withProcessOutcome = (facts) => {
		const outcome = processFailureFacts?.outcome;
		return outcome === void 0 ? facts : {
			...facts,
			outcome
		};
	};
	const publishedProcessFailure = processFailure.catch(async (error) => {
		await new Promise((resolve) => {
			setImmediate(resolve);
		});
		throw error;
	});
	let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; requestCancel(); }, spec.turnTimeoutMs);
  const result = settleRunResult({
		attempt: async () => {
			try {
				const terminal = await Promise.race([wire.runTurn(texts, runAbort.signal), publishedProcessFailure]);
				if (terminal.stopReason === "completed") return terminal;
				await new Promise((resolve) => {
					setImmediate(resolve);
				});
				const facts = withProcessOutcome(wire.collectFailure());
				return {
					...terminal,
					diagnostic: recordFailureDiagnostic(facts)
				};
			} catch (error) {
				await new Promise((resolve) => {
					setImmediate(resolve);
				});
				const endedBeforeTerminal = wire.endedBeforeTerminal();
				if (endedBeforeTerminal && processFailureFacts === void 0 && !runAbort.signal.aborted) try {
					if (await child.waitForExit(AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)))) await child.done;
				} catch {}
				const facts = error instanceof CodexRunFailure ? error.facts : endedBeforeTerminal && processFailureFacts !== void 0 ? processFailureFacts : withProcessOutcome(wire.collectFailure() ?? { stage: "turn", category: "unknown" });
				recordFailureDiagnostic(facts);
				throw error instanceof CodexRunFailure ? error : new CodexRunFailure(facts, thrown(error));
			}
		},
		collectOutput,
		collectDiagnostic: () => diagnostic,
		cancelled: () => runAbort.signal.aborted && !timedOut,
		onError: spec.onError,
		signal: request.signal,
		onAbort
	});
  const taggedResult = result.then(value => {
    const ids = { threadKey: spec.store.key, threadId: wire.threadId, turnId: wire.turnId };
    const identity = "Codex persistent thread: " + wire.threadId + "; turn: " + (wire.turnId ?? "unstarted") + "; key: " + spec.store.key;
    spec.outcome = timedOut ? "timeout" : value.stopReason;
    spec.failure ??= wire.collectFailure();
    spec.store.update({ terminalResult: value });
    return { ...value, ...ids, diagnostic: [value.diagnostic, timedOut ? "Codex turn timeout exceeded" : undefined, identity].filter(Boolean).join("\n") };
  }).finally(() => clearTimeout(timeout));
  const handle = subprocessRunHandle({
		id: brandString(randomUUID()),
		result: taggedResult,
		signal: request.signal,
		onAbort,
		requestCancel,
		teardown: async () => {
      let cleanupError;
      try { await disposeProcess(); }
      catch (error) { cleanupError = error; throw error; }
      finally {
        await taggedResult;
        await spec.store.close(cleanupError ? "teardown-failed" : spec.outcome ?? "cancelled", { failure: spec.failure ?? null });
      }
    }
  });
  return Object.assign(handle, { threadKey: spec.store.key, threadId: wire.threadId, getTurnId: () => wire.turnId,
    canSteer: () => !wire.closed && !wire.terminalObserved && !!wire.turnId, steer: (text, signal) => wire.steer(text, signal) });
}
//#endregion
export { CodexAppServerWire, startCodexRun };
