/**
 * EVERY CHANGE fde-agent makes to eve 0.25.1, in one readable list (mold_v1-184).
 *
 * eve ships minified ES modules, so a unified diff of it is one long line per file. This list is the source of
 * patches/eve+0.25.1.patch: `node scripts/eve-patch/apply.mjs` applies it to a PRISTINE node_modules/eve (each `find`
 * must occur exactly once in its file, or nothing is written), and `npx patch-package eve` then records the result.
 * `npm run check:eve-patch` proves the installed eve is 0.25.1 with exactly this patch applied.
 *
 * Two new modules are copied in whole from scripts/eve-patch/files/ (readable, commented):
 *   harness/detached-delegations.js     pure helpers (also used by workflow code)
 *   execution/parent-session-delivery.js a detached delegation's way home
 *
 * What the opt-in does — `defineAgent({ subagents: { batch: "detach", detachAfterMs } })`, default "all" (eve's own
 * behaviour, unchanged) — and how each piece below serves it is in docs/SPECIALIST_HANDBACK.md "Per-result delegation".
 */

/** @typedef {{ file: string; why: string; find: string; replace: string }} Change */

/** The local world's process-wide note of steps running INLINE (mold_v1-191 below): step key → { at, owner }. */
const INL = "(globalThis[Symbol.for(`eve.local.inlineRunningSteps`)]??=new Map)";

/** @type {Change[]} */
export const CHANGES = [
  /* ---- the setting -------------------------------------------------------------------------------------------- */
  {
    file: "internal/authored-definition/core.js",
    why: "defineAgent accepts `subagents` (unknown keys are refused, so the key is added to the known list)",
    find: "`build`,`compaction`,`description`,`experimental`,`limits`,`model`,`modelContextWindowTokens`,`modelOptions`,`outputSchema`,`reasoning`]",
    replace: "`build`,`compaction`,`description`,`experimental`,`limits`,`model`,`modelContextWindowTokens`,`modelOptions`,`outputSchema`,`reasoning`,`subagents`]",
  },
  {
    file: "internal/authored-definition/core.js",
    why: "normalizeAgentDefinition: validate `subagents: { batch: \"all\" | \"detach\", detachAfterMs?: integer >= 0 }`",
    find: "o.limits!==void 0&&(s.limits=normalizeAgentLimitsDefinition(o.limits,i)),s}",
    replace:
      "o.limits!==void 0&&(s.limits=normalizeAgentLimitsDefinition(o.limits,i)),o.subagents!==void 0&&(s.subagents=normalizeAgentSubagentsDefinition(o.subagents,i)),s}" +
      "function normalizeAgentSubagentsDefinition(e,t){let n=expectObjectRecord(e,t);expectOnlyKnownKeys(n,[`batch`,`detachAfterMs`],t);let r={};" +
      "if(n.batch!==void 0){if(n.batch!==`all`&&n.batch!==`detach`)throw Error(`${t} \"subagents.batch\" must be \"all\" or \"detach\".`);r.batch=n.batch}" +
      "if(n.detachAfterMs!==void 0){let e=n.detachAfterMs;if(typeof e!=`number`||!Number.isInteger(e)||e<0)throw Error(`${t} \"subagents.detachAfterMs\" must be a whole number of milliseconds, 0 or more.`);r.detachAfterMs=e}return r}",
  },
  {
    file: "compiler/normalize-agent-config.js",
    why: "compileAgentConfig: carry `subagents` into the compiled manifest",
    find: "a.limits!==void 0&&(l.limits={maxInputTokensPerSession:a.limits.maxInputTokensPerSession,maxOutputTokensPerSession:a.limits.maxOutputTokensPerSession})",
    replace:
      "a.limits!==void 0&&(l.limits={maxInputTokensPerSession:a.limits.maxInputTokensPerSession,maxOutputTokensPerSession:a.limits.maxOutputTokensPerSession}),a.subagents!==void 0&&(l.subagents={batch:a.subagents.batch,detachAfterMs:a.subagents.detachAfterMs})",
  },
  {
    file: "compiler/manifest.js",
    why: "compiledAgentConfigSchema (strict): admit `subagents`",
    find: "limits:compiledAgentLimitsDefinitionSchema.optional()}).strict()",
    replace:
      "limits:compiledAgentLimitsDefinitionSchema.optional(),subagents:z.object({batch:z.enum([`all`,`detach`]).optional(),detachAfterMs:z.number().int().min(0).optional()}).strict().optional()}).strict()",
  },
  {
    file: "compiler/manifest.js",
    why: "createCompiledAgentNodeManifest: copy `subagents`",
    find: "limits:e.config.limits===void 0?void 0:{maxInputTokensPerSession:e.config.limits.maxInputTokensPerSession,maxOutputTokensPerSession:e.config.limits.maxOutputTokensPerSession}",
    replace:
      "limits:e.config.limits===void 0?void 0:{maxInputTokensPerSession:e.config.limits.maxInputTokensPerSession,maxOutputTokensPerSession:e.config.limits.maxOutputTokensPerSession},subagents:e.config.subagents===void 0?void 0:{batch:e.config.subagents.batch,detachAfterMs:e.config.subagents.detachAfterMs}",
  },
  {
    file: "runtime/resolve-agent.js",
    why: "resolveAgent: the runtime config (`resolvedAgent.config`) carries `subagents`",
    find: "e.config.limits!==void 0&&(n.limits={maxInputTokensPerSession:e.config.limits.maxInputTokensPerSession,maxOutputTokensPerSession:e.config.limits.maxOutputTokensPerSession}),n}",
    replace:
      "e.config.limits!==void 0&&(n.limits={maxInputTokensPerSession:e.config.limits.maxInputTokensPerSession,maxOutputTokensPerSession:e.config.limits.maxOutputTokensPerSession}),e.config.subagents!==void 0&&(n.subagents={batch:e.config.subagents.batch,detachAfterMs:e.config.subagents.detachAfterMs}),n}",
  },
  {
    file: "shared/agent-definition.d.ts",
    why: "types: `subagents` on the public agent definition",
    find: "    /**\n     * Framework-owned runtime limits for this agent's runs.\n     */\n    readonly limits?: AgentLimitsDefinition;\n    /**\n     * Optional structured return type",
    replace:
      "    /**\n     * Framework-owned runtime limits for this agent's runs.\n     */\n    readonly limits?: AgentLimitsDefinition;\n" +
      "    /**\n     * How the results of delegations called in one step reach this agent (fde-agent patch, mold_v1-184).\n     * `\"all\"` (default): together, when every one is back. `\"detach\"`: once at least one is back and another is still\n     * out, the ones that are back are handed over at once (immediately when one still out waits on the person,\n     * otherwise after `detachAfterMs`, default 10000), each one still out as `{ status: \"running\" }`, and its result\n     * arrives as that delegation's tool result in a turn of its own when it finishes. Conversation sessions only.\n     */\n" +
      "    readonly subagents?: {\n        readonly batch?: \"all\" | \"detach\";\n        readonly detachAfterMs?: number;\n    };\n" +
      "    /**\n     * Optional structured return type",
  },

  /* ---- mixed versions: the session driver says it can take a late result ------------------------------------ */
  {
    file: "execution/durable-session-migrations/turn-workflow.js",
    why: "createTurnWorkflowInput: a driver with this patch announces `delegationResults`; a turn detaches only under such a driver (a session whose driver predates the patch — pinned to an older deployment — keeps \"all\")",
    find: "driverCapabilities:{cancelledTurnSettle:!0,turnInbox:!0}",
    replace: "driverCapabilities:{cancelledTurnSettle:!0,delegationResults:!0,turnInbox:!0}",
  },

  /* ---- the turn: hand over what is in ------------------------------------------------------------------------ */
  {
    file: "execution/workflow-steps.js",
    why: "import the helpers",
    find: 'import{getPendingRuntimeActionBatch}from"#harness/runtime-actions.js";',
    replace: 'import{getPendingRuntimeActionBatch}from"#harness/runtime-actions.js";import{subagentBatchStepFields}from"#harness/detached-delegations.js";',
  },
  {
    file: "execution/workflow-steps.js",
    why: "turnStep: a park on a batch of delegations says the agent's batch mode (only when it is \"detach\")",
    find: ":{action:`park`,...derivePendingState(S.session),serializedContext:w,sessionState:T}}",
    replace: ":{action:`park`,...derivePendingState(S.session),...subagentBatchStepFields(u.resolvedAgent.config,S.session,c.get(InitiatorAuthKey)),serializedContext:w,sessionState:T}}",
  },
  {
    file: "execution/workflow-steps.js",
    why: "(the session creator's auth decides a per-session override: `eve_subagent_batch: \"all\"` keeps eve's own batch, e.g. for a session a program started)",
    find: 'import{AuthKey,CapabilitiesKey,ModeKey}from"#context/keys.js";',
    replace: 'import{AuthKey,CapabilitiesKey,InitiatorAuthKey,ModeKey}from"#context/keys.js";',
  },
  {
    file: "execution/workflow-steps.js",
    why: "turnStep: a batch handed over early says which delegations are still out (`detachedDelegations`)",
    find: "o.input?.kind===`runtime-action-result`&&(recordSubagentUsageSpans(o.input.results),h={runtimeActionResults:o.input.results})",
    replace:
      "o.input?.kind===`runtime-action-result`&&(recordSubagentUsageSpans(o.input.results),h={runtimeActionResults:o.input.results,...o.input.detachedDelegations===void 0?{}:{detachedDelegations:o.input.detachedDelegations}})",
  },
  {
    file: "execution/workflow-steps.js",
    why: "turnStep: a late result in a delivery becomes the turn's `delegationResults` input; it never passes through the channel's deliver (it is not a message)",
    find: "if(o.input?.kind===`deliver`){let e=[];for(let n of o.input.payloads){let r=l.deliver?await l.deliver(n,m):defaultDeliverResult(n);r!=null&&e.push(r)}h=e.length===0?void 0:e.reduce(coalesceTurnInputs)}",
    replace:
      "if(o.input?.kind===`deliver`){let e=[],lateResults=[];for(let n of o.input.payloads){let w=n;if(n!=null&&(n.delegationResults!==void 0||n.delegationRequests!==void 0)){let{delegationResults:q,delegationRequests:_q,...x}=n;Array.isArray(q)&&lateResults.push(...q);if(Object.keys(x).length===0)continue;w=x}let r=l.deliver?await l.deliver(w,m):defaultDeliverResult(w);r!=null&&e.push(r)}h=e.length===0?void 0:e.reduce(coalesceTurnInputs);lateResults.length>0&&(h={...h,delegationResults:lateResults})}",
  },
  {
    file: "execution/dispatch-runtime-actions-step.js",
    why: "import the request key",
    find: 'import{resolveSubagentDepth}from"#harness/subagent-depth.js";',
    replace: 'import{resolveSubagentDepth}from"#harness/subagent-depth.js";import{getRuntimeActionRequestKey}from"#runtime/actions/keys.js";',
  },
  {
    file: "execution/dispatch-runtime-actions-step.js",
    why: "dispatchRuntimeActionsStep (detach): collect what a detached delegation is (key, call, child)",
    find: "E=g,D=[];try{",
    replace: "E=g,D=[],detachable=[];try{",
  },
  {
    file: "execution/dispatch-runtime-actions-step.js",
    why: "dispatchRuntimeActionsStep (detach): the child carries its parent SESSION's delivery token; and whether its batch can be handed over early at all (two or more actions): a lone delegation sends no session copy, only a fallback when the turn's inbox is gone",
    find: "parentContinuationToken:e.parentContinuationToken,session:g,source:o})",
    replace: "parentContinuationToken:e.parentContinuationToken,...e.detach===!0&&g.continuationToken?{parentSessionContinuationToken:g.continuationToken,parentSessionCopies:p.actions.length>1}:{},session:g,source:o})",
  },
  {
    file: "execution/dispatch-runtime-actions-step.js",
    why: "dispatchRuntimeActionsStep (detach): record each local delegation started",
    find: "E=recordPendingSubagentChild({callId:r.callId,child:{continuationToken:c,kind:`local`,sessionId:i},session:E}),a=r.name,u=r.subagentName;break}",
    replace:
      "E=recordPendingSubagentChild({callId:r.callId,child:{continuationToken:c,kind:`local`,sessionId:i},session:E}),a=r.name,u=r.subagentName,e.detach===!0&&g.continuationToken&&detachable.push({callId:r.callId,childContinuationToken:c,childSessionId:i,key:getRuntimeActionRequestKey(r),name:r.name,subagentName:r.subagentName});break}",
  },
  {
    file: "execution/dispatch-runtime-actions-step.js",
    why: "dispatchRuntimeActionsStep (detach): `subagent.called` says the delegation is detachable (it reports home itself, also when stopped)",
    find: "let d=await callAdapterEventHandler(_,createSubagentCalledEvent({",
    replace: "let d=await callAdapterEventHandler(_,withDetachableFlag(e.detach===!0&&r.kind===`subagent-call`&&!!g.continuationToken,createSubagentCalledEvent({",
  },
  {
    file: "execution/dispatch-runtime-actions-step.js",
    why: "(the call above closes one more parenthesis)",
    find: "workflowId:workflowEntryReference.workflowId}),C);",
    replace: "workflowId:workflowEntryReference.workflowId})),C);",
  },
  {
    file: "execution/dispatch-runtime-actions-step.js",
    why: "dispatchRuntimeActionsStep (detach): return the delegations to the turn; withDetachableFlag",
    find: "return{results:D,sessionState:E===g?e.sessionState:createDurableSessionState({session:E})}}function createRemoteAgentStartFailureResult(e){",
    replace:
      "return{results:D,sessionState:E===g?e.sessionState:createDurableSessionState({session:E}),...e.detach===!0?{delegations:detachable}:{}}}" +
      "function withDetachableFlag(e,t){return e?{...t,data:{...t.data,detachable:!0}}:t}function createRemoteAgentStartFailureResult(e){",
  },
  {
    file: "execution/forward-turn-delivery-step.js",
    why: "armDetachTimerStep (new): the bound's timer, in the process that runs the step, NOT durable: after `ms` it resumes the wait's own timer hook with `{ kind: \"detach-timer\" }` and ignores a hook that is gone. On Vercel the function is kept alive for it with the request context's waitUntil. A process that stops loses it: the batch then waits as eve's own does, unless a question hands it over",
    find: "export{forwardTurnDeliveryStep};",
    replace:
      "async function armDetachTimerStep(e){\"use step\";let t=new Promise(t=>{setTimeout(()=>{resumeHook(e.token,{kind:`detach-timer`}).catch(()=>{}).finally(t)},e.ms)}),n=globalThis[Symbol.for(`@vercel/request-context`)]?.get?.()?.waitUntil;typeof n==`function`&&n(t)}export{armDetachTimerStep,forwardTurnDeliveryStep};",
  },
  {
    file: "execution/subagent-tool.js",
    why: "buildSubagentRunInput: put the parent session's delivery token in the subagent adapter state",
    find: "parentSessionId:l.sessionId,subagentName:r.subagentName,",
    replace: "parentSessionId:l.sessionId,...n.parentSessionContinuationToken===void 0?{}:{parentSessionContinuationToken:n.parentSessionContinuationToken,parentSessionCopies:n.parentSessionCopies!==!1},subagentName:r.subagentName,",
  },
  {
    file: "execution/turn-workflow.js",
    why: "imports: the pure helpers, the result key, the step that arms the bound's timer",
    find: 'import{createHook,getWorkflowMetadata}from"#compiled/@workflow/core/index.js";',
    replace:
      'import{createHook,getWorkflowMetadata}from"#compiled/@workflow/core/index.js";import{anyResultIn,planDetach}from"#harness/detached-delegations.js";import{getRuntimeActionResultKey}from"#runtime/actions/keys.js";import{armDetachTimerStep}from"#execution/forward-turn-delivery-step.js";',
  },
  {
    file: "execution/turn-workflow.js",
    why: "runTurnOwnedWorkflow: one pending inbox read survives a detaching wait (a late payload is never dropped by a second next())",
    find: "l=c[Symbol.asyncIterator](),u=new TurnExecutionCursor(",
    replace: "l=c[Symbol.asyncIterator](),detachInbox={pending:void 0,timers:0},u=new TurnExecutionCursor(",
  },
  {
    file: "execution/turn-workflow.js",
    why: "runTurnOwnedWorkflow: detach only for a conversation, under a driver that takes late results, on a park whose agent opted in",
    find: "let o=i.action===`dispatch-workflow-runtime-actions`||i.action===`park`?i.pendingRuntimeActionKeys:void 0;if(o!==void 0){",
    replace:
      "let o=i.action===`dispatch-workflow-runtime-actions`||i.action===`park`?i.pendingRuntimeActionKeys:void 0,detachBatch=o!==void 0&&i.action===`park`&&e.mode===`conversation`&&e.driverCapabilities?.delegationResults===!0&&i.subagentBatch?.mode===`detach`?i.subagentBatch:void 0;if(o!==void 0){",
  },
  {
    file: "execution/turn-workflow.js",
    why: "runTurnOwnedWorkflow: under \"detach\", dispatch with the session token and wait with waitForRuntimeActionResultsDetaching; \"all\" calls eve's own waitForRuntimeActionResults exactly as before",
    find:
      "sessionState:u.sessionState});await u.adopt(e);let r=await waitForRuntimeActionResults({bufferedDeliveries:f,cancellation:h,cursor:u,inboxToken:c.token,initialResults:e.results,iterator:l,nextDeliveryRequestId,pendingActionKeys:o});if(r===`cancelled`){p=void 0;continue}p={kind:`runtime-action-result`,results:r};continue}",
    replace:
      "sessionState:u.sessionState,...detachBatch===void 0?{}:{detach:!0}});await u.adopt(e);" +
      "let r=detachBatch===void 0?await waitForRuntimeActionResults({bufferedDeliveries:f,cancellation:h,cursor:u,inboxToken:c.token,initialResults:e.results,iterator:detachInbox.pending===void 0?l:pendingFirstIterator(l,detachInbox),nextDeliveryRequestId,pendingActionKeys:o})" +
      ":await waitForRuntimeActionResultsDetaching({bufferedDeliveries:f,cancellation:h,cursor:u,delegations:e.delegations??[],detachAfterMs:detachBatch.detachAfterMs,inbox:detachInbox,inboxToken:c.token,initialResults:e.results,iterator:l,nextDeliveryRequestId,pendingActionKeys:o,timerToken:`${c.token}:detach-timer:${String(detachInbox.timers++)}`});" +
      "if(r===`cancelled`){p=void 0;continue}p=detachBatch===void 0?{kind:`runtime-action-result`,results:r}:{kind:`runtime-action-result`,results:r.results,...r.detached.length>0?{detachedDelegations:r.detached}:{}};continue}",
  },
  {
    file: "execution/turn-workflow.js",
    why: "waitForRuntimeActionResultsDetaching: eve's wait, plus: hand the batch over with \"reports later\" for the ones still out once one is in and another waits on the person (at once) or the bound passed. The bound is NOT a durable sleep (that would wake the run later, after the batch resolved): when the first result is in, the wait creates a hook of its own (`<inbox>:detach-timer:<n>`, accepting only `{ kind: \"detach-timer\" }`) and arms an in-process timer that resumes it; every way out of the wait disposes the hook, so a timer that fires later finds nothing and wakes nothing",
    find: "async function runLegacyTurnWorkflow(e){",
    replace:
      "const DETACH_TIMER=Symbol(`detach-timer`);" +
      "function pendingFirstIterator(e,t){return{next(){if(t.pending!==void 0){let e=t.pending;return t.pending=void 0,e}return e.next()}}}" +
      "async function waitForRuntimeActionResultsDetaching(t){let n,r=[...t.initialResults],asked=new Set,timer,timerHook,timerFired=!1,byKey=new Map(t.delegations.map(e=>[e.key,e])),batchCallIds=new Set(t.delegations.map(e=>e.callId)),endTimer=async()=>{timerHook!==void 0&&(await disposeHook(timerHook),timerHook=void 0)},handOver=async e=>(n!==void 0&&await t.cursor.send({kind:`turn-delivery-cancelled`,requestId:n}),await endTimer(),e);" +
      "for(;;){let i=resolveRuntimeActionResultsForKeys({pendingKeys:t.pendingActionKeys,results:r});if(i!==void 0)return handOver({detached:[],results:i});" +
      "let d=planDetach({asked,delegations:byKey,pendingKeys:t.pendingActionKeys,resultKey:getRuntimeActionResultKey,results:r,timerFired});if(d!==void 0)return handOver(d);" +
      "if(timer===void 0&&anyResultIn(t.pendingActionKeys,r,getRuntimeActionResultKey)){timerHook=createHook({token:t.timerToken});let e=timerHook[Symbol.asyncIterator]();timer=(async()=>{for(;;){let t=await e.next();if(t.done)return new Promise(()=>{});if(t.value?.kind===`detach-timer`)return DETACH_TIMER}})();await armDetachTimerStep({ms:t.detachAfterMs,token:t.timerToken})}" +
      "t.cursor.sessionState.hasProxyInputRequests&&n===void 0&&(n=t.nextDeliveryRequestId(),await t.cursor.send({continuationToken:t.cursor.sessionState.continuationToken,inboxToken:t.inboxToken,kind:`turn-delivery-request`,requestId:n}));" +
      "let a=t.inbox.pending??=t.iterator.next();a.catch(()=>{});let races=[a];t.cancellation!==void 0&&races.push(t.cancellation.requested);timer!==void 0&&!timerFired&&races.push(timer);" +
      "let o=await(races.length===1?a:Promise.race(races));if(o===DETACH_TIMER){timerFired=!0;continue}" +
      "if(o===`cancel`)return n!==void 0&&await t.cursor.send({kind:`turn-delivery-cancelled`,requestId:n}),await endTimer(),`cancelled`;t.inbox.pending=void 0;" +
      "if(o.done)throw Error(`Turn inbox closed before runtime actions completed.`);let s=o.value;if(s.kind===`runtime-action-result`){r.push(...s.results);continue}" +
      "if(s.kind===`subagent-input-request`||s.kind===`subagent-authorization-event`){let e=await runProxySubagentEventStep({hookPayload:s,parentWritable:t.cursor.parentWritable,serializedContext:t.cursor.serializedContext,sessionState:t.cursor.sessionState});await t.cursor.adopt(e);(s.kind===`subagent-input-request`||s.event?.type===`authorization.required`)&&batchCallIds.has(s.callId)&&asked.add(s.callId);continue}" +
      "if(s.kind===`driver-delivery`&&s.requestId===n){await t.cursor.send({kind:`turn-delivery-accepted`,requestId:s.requestId}),n=void 0;let e=await routeDeliverToChildren({auth:s.delivery.auth,parentWritable:t.cursor.parentWritable,payloads:s.delivery.payloads,sessionState:t.cursor.sessionState});e!==void 0&&t.bufferedDeliveries.push({...s.delivery,payloads:[e]})}}}" +
      "async function runLegacyTurnWorkflow(e){",
  },
  {
    file: "harness/runtime-actions.js",
    why: "import the helpers",
    find: 'import{getRuntimeActionRequestKey,getRuntimeActionResultKey}from"#runtime/actions/keys.js";',
    replace: 'import{getRuntimeActionRequestKey,getRuntimeActionResultKey}from"#runtime/actions/keys.js";import{recordDetachedDelegations}from"#harness/detached-delegations.js";',
  },
  {
    file: "harness/runtime-actions.js",
    why: "resolvePendingRuntimeActions: which results of this batch are \"reports later\" placeholders",
    find: "if(a===void 0)return{messages:[...t.session.history],outcome:`unresolved`,session:t.session};",
    replace: "if(a===void 0)return{messages:[...t.session.history],outcome:`unresolved`,session:t.session};let detachedIds=new Set((t.stepInput?.detachedDelegations??[]).map(e=>e.callId));",
  },
  {
    file: "harness/runtime-actions.js",
    why: "resolvePendingRuntimeActions: a placeholder is not `subagent.completed` (its action.result is still emitted: the chat shows it as working, reports later)",
    find: "for(let n of a)n.kind===`subagent-result`&&n.isError!==!0&&await t.emit(",
    replace: "for(let n of a)n.kind===`subagent-result`&&n.isError!==!0&&!detachedIds.has(n.callId)&&await t.emit(",
  },
  {
    file: "harness/runtime-actions.js",
    why: "resolvePendingRuntimeActions: a detached child's proxied questions stay routable (they are cleared when its late result is delivered)",
    find: "t!==void 0&&(s=clearProxyInputRequestsForChild(s,t))",
    replace: "t!==void 0&&!detachedIds.has(e.callId)&&(s=clearProxyInputRequestsForChild(s,t))",
  },
  {
    file: "harness/runtime-actions.js",
    why: "resolvePendingRuntimeActions: record the detached delegations in the session's durable state",
    find: "(s=setTurnUsageState(s,accumulateSessionUsage({previous:getTurnUsageState(s.state),usage:e.usage})));let l=a.map(",
    replace: "(s=setTurnUsageState(s,accumulateSessionUsage({previous:getTurnUsageState(s.state),usage:e.usage})));detachedIds.size>0&&(s=recordDetachedDelegations(s,t.stepInput.detachedDelegations));let l=a.map(",
  },

  /* ---- the late result: tool-role, once ---------------------------------------------------------------------- */
  {
    file: "harness/input-requests.js",
    why: "hasStepInput: a late delegation result is step input (the turn gets its turn.started)",
    find: "function hasStepInput(e){return e===void 0?!1:e.message!==void 0||(e.inputResponses?.length??0)>0}",
    replace: "function hasStepInput(e){return e===void 0?!1:e.message!==void 0||(e.inputResponses?.length??0)>0||(e.delegationResults?.length??0)>0}",
  },
  {
    file: "harness/input-requests.js",
    why: "compactStepInput keeps late results (deferred input)",
    find: "(e.inputResponses?.length??0)>0&&(t.inputResponses=e.inputResponses),e.message!==void 0&&(t.message=e.message),",
    replace: "(e.inputResponses?.length??0)>0&&(t.inputResponses=e.inputResponses),(e.delegationResults?.length??0)>0&&(t.delegationResults=e.delegationResults),e.message!==void 0&&(t.message=e.message),",
  },
  {
    file: "harness/input-requests.js",
    why: "export queueDeferredStepInput (a late result that lands while the main agent waits on its own question is deferred, not lost)",
    find: "export{consumeDeferredStepInput,createRuntimeToolCallActionFromToolCall,",
    replace: "export{queueDeferredStepInput,consumeDeferredStepInput,createRuntimeToolCallActionFromToolCall,",
  },
  {
    file: "harness/messages.js",
    why: "coalesceTurnInputs: late results of two inputs are concatenated, not lost",
    find: "a!==void 0&&(o.outputSchema=a),o}",
    replace: "a!==void 0&&(o.outputSchema=a),mergeDelegationFields(o,e,t)}",
  },
  {
    file: "harness/messages.js",
    why: "import the helper (prepended)",
    find: "function coalesceTurnInputs(e,t){",
    replace: 'import{mergeDelegationFields}from"#harness/detached-delegations.js";function coalesceTurnInputs(e,t){',
  },
  {
    file: "execution/deliver-payloads.js",
    why: "coalesceDeliverPayloads: delegation fields are concatenated across payloads (never overwritten)",
    find: "e!==`inputResponses`&&n!==void 0&&(t[e]=n);r.inputResponses!==void 0&&n.push(...r.inputResponses)}return n.length>0&&(t.inputResponses=n),t}",
    replace:
      "e!==`inputResponses`&&e!==`delegationResults`&&e!==`delegationRequests`&&n!==void 0&&(t[e]=n);r.inputResponses!==void 0&&n.push(...r.inputResponses)}" +
      "for(let n of[`delegationResults`,`delegationRequests`]){let r=e.flatMap(e=>Array.isArray(e?.[n])?e[n]:[]);r.length>0&&(t[n]=r)}return n.length>0&&(t.inputResponses=n),t}",
  },
  {
    file: "harness/tool-loop.js",
    why: "imports",
    find: "import{consumeDeferredStepInput,getApprovedTools,getPendingInputRequestIds,hasDeferredStepInput,hasStepInput,resolvePendingInput,setPendingInputBatch}from\"#harness/input-requests.js\";",
    replace:
      "import{consumeDeferredStepInput,getApprovedTools,getPendingInputRequestIds,hasDeferredStepInput,hasPendingInputBatch,hasStepInput,queueDeferredStepInput,resolvePendingInput,setPendingInputBatch}from\"#harness/input-requests.js\";import{buildLateResultMessages,takeDelegationResults}from\"#harness/detached-delegations.js\";",
  },
  {
    file: "harness/tool-loop.js",
    why: "executeStepBody: while the main agent still waits on ITS OWN question or approval (resolvePendingInput unresolved), a late result is deferred to the turn that answers it — never before resolvePendingInput, so the answering turn delivers it instead of deferring it again",
    find: "if(F.outcome===`unresolved`)return n&&F.deferredMessage===!0&&hasStepInput(v)?",
    replace: "if(F.outcome===`unresolved`)return F=deferLateDelegationResults(F,S.input),n&&F.deferredMessage===!0&&hasStepInput(v)?",
  },
  {
    file: "harness/tool-loop.js",
    why: "executeStepBody: deliver late results (once each) as tool-role messages, with their action.result — after the session-limit continuation, which, when it ends the step, defers them instead of dropping them",
    find: "if(L.result!==null)return L.result;if(b=L.session,",
    replace: "if(L.result!==null)return deferLateDelegationResults(L.result,S.input);if(b=L.session,b=await deliverLateDelegationResults({emissionState:x,emit:n,messages:I,session:b,stepInput:S.input}),",
  },
  {
    file: "harness/tool-loop.js",
    why: "deliverLateDelegationResults",
    find: "function extractTokenUsageDelta(e){",
    replace:
      "async function deliverLateDelegationResults(e){let t=e.stepInput?.delegationResults;if(t===void 0||t.length===0)return e.session;let n=takeDelegationResults(e.session,t);" +
      "if(e.emit!==void 0)for(let{result:t}of n.delivered)t.isError!==!0&&await e.emit({data:{callId:t.callId,output:typeof t.output==`string`?t.output:JSON.stringify(t.output),subagentName:t.subagentName},type:`subagent.completed`}),await e.emit(createActionResultEvent({result:t,sequence:e.emissionState.sequence,stepIndex:e.emissionState.stepIndex,turnId:e.emissionState.turnId}));" +
      "for(let t of buildLateResultMessages(n.delivered))e.messages.push(t);return n.session}" +
      "function deferLateDelegationResults(e,t){let n=t?.delegationResults;return n===void 0||n.length===0||e.deferredMessage===!0||e.session===void 0?e:{...e,session:queueDeferredStepInput(e.session,{delegationResults:n})}}" +
      "function extractTokenUsageDelta(e){",
  },

  /* ---- the child: its way home ------------------------------------------------------------------------------- */
  {
    file: "execution/delegated-parent-notification.js",
    why: "notifyDelegatedParentStep: a detachable delegation's result goes to the turn's inbox (if the batch still waits) AND the parent session (if it was detached); the other one is dropped by its receiver. Without the session token: exactly as before.",
    find:
      "let n=String(t.state?.parentContinuationToken??``);n!==``&&await resumeHook(n,{kind:`runtime-action-result`,results:[e.usage===void 0||e.result.isError===!0?e.result:{...e.result,usage:e.usage}]})}",
    replace:
      "let n=String(t.state?.parentContinuationToken??``),r=e.usage===void 0||e.result.isError===!0?e.result:{...e.result,usage:e.usage},s=String(t.state?.parentSessionContinuationToken??``);" +
      "if(s!==``){await sendDelegationHome({always:t.state?.parentSessionCopies!==!1,hookPayload:{kind:`runtime-action-result`,results:[r]},parentContinuationToken:n,parentSessionContinuationToken:s,parentSessionId:String(t.state?.parentSessionId??``),sessionPayload:{delegationResults:[r]}});return}" +
      "n!==``&&await resumeHook(n,{kind:`runtime-action-result`,results:[r]})}",
  },
  {
    file: "execution/delegated-parent-notification.js",
    why: "import",
    find: 'import{resumeHook}from"#internal/workflow/runtime.js";',
    replace: 'import{resumeHook}from"#internal/workflow/runtime.js";import{sendDelegationHome}from"#execution/parent-session-delivery.js";',
  },
  {
    file: "execution/delegated-parent-result.js",
    why: "createDelegatedSubagentStoppedResult: what a detachable delegation reports when it is stopped",
    find: "export{createDelegatedSubagentErrorResult,createDelegatedSubagentSuccessResult};",
    replace:
      "function createDelegatedSubagentStoppedResult(t){let n=createDelegatedSubagentSuccessResult(t,``);if(n!==void 0)return{...n,isError:!0,output:{code:`SUBAGENT_STOPPED`,message:`This specialist was stopped before it finished. It returned no result.`}}}" +
      "export{createDelegatedSubagentErrorResult,createDelegatedSubagentStoppedResult,createDelegatedSubagentSuccessResult};",
  },
  {
    file: "execution/subagent-adapter.js",
    why: "import",
    find: 'import{resumeHook}from"#internal/workflow/runtime.js";',
    replace: 'import{resumeHook}from"#internal/workflow/runtime.js";import{sendDelegationHome}from"#execution/parent-session-delivery.js";',
  },
  {
    file: "execution/subagent-adapter.js",
    why: "input.requested: pass the session route along",
    find: "kind:`subagent-input-request`,subagentName:i.subagentName},parentContinuationToken:i.parentContinuationToken})}};",
    replace: "kind:`subagent-input-request`,subagentName:i.subagentName},parentContinuationToken:i.parentContinuationToken,...sessionRoute(i)})}};function sessionRoute(e){return typeof e.parentSessionContinuationToken==`string`&&e.parentSessionContinuationToken!==``?{parentSessionContinuationToken:e.parentSessionContinuationToken,parentSessionCopies:e.parentSessionCopies!==!1,parentSessionId:e.parentSessionId}:{}}",
  },
  {
    file: "execution/subagent-adapter.js",
    why: "authorization events: pass the session route along",
    find: "kind:`subagent-authorization-event`,subagentName:n.subagentName},parentContinuationToken:n.parentContinuationToken})}",
    replace: "kind:`subagent-authorization-event`,subagentName:n.subagentName},parentContinuationToken:n.parentContinuationToken,...sessionRoute(n)})}",
  },
  {
    file: "execution/subagent-adapter.js",
    why: "forwardSubagentAuthorizationEventStep: a detachable delegation's authorization event reaches the main thread through the session when the turn is gone",
    find: 'async function forwardSubagentAuthorizationEventStep(t){"use step";try{',
    replace: 'async function forwardSubagentAuthorizationEventStep(t){"use step";if(t.parentSessionContinuationToken!==void 0){await sendDelegationHome({always:!1,hookPayload:t.hookPayload,parentContinuationToken:t.parentContinuationToken,parentSessionContinuationToken:t.parentSessionContinuationToken,parentSessionId:t.parentSessionId,sessionPayload:{delegationRequests:[t.hookPayload]}});return}try{',
  },
  {
    file: "execution/subagent-adapter.js",
    why: "forwardSubagentInputRequestStep: a detachable delegation's question goes to the turn's inbox (if it still waits) AND the parent session (if detached); the driver drops a question the main thread already holds",
    find: 'async function forwardSubagentInputRequestStep(t){"use step";try{',
    replace: 'async function forwardSubagentInputRequestStep(t){"use step";if(t.parentSessionContinuationToken!==void 0){await sendDelegationHome({always:t.parentSessionCopies!==!1,hookPayload:t.hookPayload,parentContinuationToken:t.parentContinuationToken,parentSessionContinuationToken:t.parentSessionContinuationToken,parentSessionId:t.parentSessionId,sessionPayload:{delegationRequests:[t.hookPayload]}});return}try{',
  },

  /* ---- the session driver ------------------------------------------------------------------------------------ */
  {
    file: "execution/workflow-entry.js",
    why: "imports",
    find: 'import{readSerializedSubagentDepth}from"#harness/subagent-depth.js";',
    replace:
      'import{readSerializedSubagentDepth}from"#harness/subagent-depth.js";import{filterDelegationDelivery,isDetachableDelegationContext}from"#harness/detached-delegations.js";import{runProxySubagentEventStep}from"#execution/subagent-event-proxy-step.js";',
  },
  {
    file: "execution/workflow-entry.js",
    why: "import",
    find: "import{createDelegatedSubagentErrorResult,createDelegatedSubagentSuccessResult}from\"#execution/delegated-parent-result.js\";",
    replace: "import{createDelegatedSubagentErrorResult,createDelegatedSubagentStoppedResult,createDelegatedSubagentSuccessResult}from\"#execution/delegated-parent-result.js\";",
  },
  {
    file: "execution/workflow-entry.js",
    why: "runDriverLoop: a detachable delegation that is STOPPED reports it home (the batch, or the main thread if detached) — once; #114's hand-back is not used for it",
    find: "t={...t,serializedContext:n.serializedContext,sessionState:n.sessionState}}",
    replace: "t={...t,serializedContext:n.serializedContext,sessionState:n.sessionState};if(isDetachableDelegationContext(e.serializedContext))return await notifyDelegatedParentStep({result:createDelegatedSubagentStoppedResult(t.serializedContext),serializedContext:t.serializedContext}),{output:``}}",
  },
  {
    file: "execution/workflow-entry.js",
    why: "runDriverLoop: a detachable delegation listens, while parked between turns (waiting on the person's answer or an approval), on `<session>:stop-parked`: eve's cancel route falls back to it when no turn is running, so a specialist that waits on a question can be stopped too (it settles, reports SUBAGENT_STOPPED once, and ends). Only the payload `{ kind: \"stop-parked\" }` stops it — the one eve's cancel sends; eve's unauthenticated callback routes, which can resume any hook by token, send other kinds (`runtime-action-result`, `deliver`), which are ignored and the hook stays",
    find: "async function runDriverLoop(e){let n=createHook({token:`${e.sessionState.sessionId}:auth`}),r=n[Symbol.asyncIterator](),",
    replace:
      "async function runDriverLoop(e){let n=createHook({token:`${e.sessionState.sessionId}:auth`}),r=n[Symbol.asyncIterator](),parkedStop=isDetachableDelegationContext(e.serializedContext)?createParkedStop(e.sessionState.sessionId):void 0,",
  },
  {
    file: "execution/workflow-entry.js",
    why: "(dispose the parked-stop hook with the others)",
    find: "}finally{await l?.(),await c.dispose(),await disposeHook(n)}}",
    replace:
      "}finally{await l?.(),await c.dispose(),await disposeHook(n),parkedStop!==void 0&&await disposeHook(parkedStop.hook)}}const PARKED_STOP=Symbol(`parked-stop`);function createParkedStop(e){let t=createHook({token:`${e}:stop-parked`}),n=t[Symbol.asyncIterator](),r;return{hook:t,next:()=>(r??=(async()=>{for(;;){let e=await n.next();if(e.done)return new Promise(()=>{});if(e.value?.kind===`stop-parked`)return PARKED_STOP}})(),r)}}",
  },
  {
    file: "execution/workflow-runtime.js",
    why: "requestWorkflowTurnCancellation: with no turn running, a cancel without a turn id stops a detachable delegation parked on the person (its `<session>:stop-parked` hook) instead of answering no_active_turn",
    find: "}catch(e){if(isInactiveCancelTarget(e))return{status:`no_active_turn`};throw e}}function isInactiveCancelTarget",
    replace:
      "}catch(n){if(!isInactiveCancelTarget(n))throw n;if(e.turnId===void 0)try{return await resumeHook(`${e.sessionId}:stop-parked`,{kind:`stop-parked`}),{status:`accepted`}}catch(r){if(!isInactiveCancelTarget(r))throw r}return{status:`no_active_turn`}}}function isInactiveCancelTarget",
  },
  {
    file: "execution/workflow-entry.js",
    why: "runDriverLoop: between turns, keep only what is still owed (a detached delegation's result, or a question the main thread does not hold yet), proxy such questions, then run the turn as before. A delivery without delegation fields passes through unchanged.",
    find: "let n=await waitForNextDeliver({bufferedDeliveries:s,deliveryHook:c});if(n===null)return{output:``};",
    replace:
      "let n=parkedStop===void 0?await waitForNextDeliver({bufferedDeliveries:s,deliveryHook:c}):await Promise.race([waitForNextDeliver({bufferedDeliveries:s,deliveryHook:c}),parkedStop.next()]);if(n===PARKED_STOP){t={...t,cancelled:!0};continue}if(n===null)return{output:``};" +
      "{let q=filterDelegationDelivery(n,t.sessionState.snapshot?.session?.state,t.sessionState.snapshot!==void 0);for(let o of q.requests){let r=await runProxySubagentEventStep({betweenTurns:!0,hookPayload:o,parentWritable:e.driverWritable,serializedContext:t.serializedContext,sessionState:t.sessionState});t={...t,serializedContext:r.serializedContext,sessionState:r.sessionState}}if(q.delivery===null){t={...t,cancelled:!1};continue}n=q.delivery}",
  },
  {
    file: "execution/subagent-event-proxy-step.js",
    why: "runProxySubagentEventStep: between turns (the driver) a proxied question is emitted without a turn epilogue (there is no turn to close)",
    find: "return emitProxiedSubagentEvent({ctx:await deserializeContext(e.serializedContext),durableSession:t,hookPayload:e.hookPayload,parentWritable:e.parentWritable})",
    replace: "return emitProxiedSubagentEvent({betweenTurns:e.betweenTurns===!0,ctx:await deserializeContext(e.serializedContext),durableSession:t,hookPayload:e.hookPayload,parentWritable:e.parentWritable})",
  },
  {
    file: "execution/subagent-event-proxy-step.js",
    why: "(the mode decides the epilogue)",
    find: "mode:a.require(ModeKey)",
    replace: "mode:i.betweenTurns===!0?void 0:a.require(ModeKey)",
  },

  /* ---- stopping the main thread ----------------------------------------------------------------------------- */
  {
    file: "execution/cancel-descendant-turns-step.js",
    why: "import",
    find: 'import{getPendingRuntimeActionBatch}from"#harness/runtime-actions.js";',
    replace: 'import{getPendingRuntimeActionBatch}from"#harness/runtime-actions.js";import{getDetachedDelegations}from"#harness/detached-delegations.js";',
  },
  {
    file: "execution/cancel-descendant-turns-step.js",
    why: "cancelDescendantTurnsStep: stopping the main thread stops its detached delegations too",
    find: "let r;try{r=getPendingRuntimeActionBatch((await readDurableSession(e.sessionState)).state)}catch(n){logError(log,`failed to read pending descendants during cancellation`,n,{sessionId:e.sessionState.sessionId});return}if(r===void 0)return;let i=r.childSessionIds;if(i===void 0)return;",
    replace:
      "let r,detachedChildren=[];try{let t=(await readDurableSession(e.sessionState)).state;r=getPendingRuntimeActionBatch(t),detachedChildren=Object.values(getDetachedDelegations(t))}catch(n){logError(log,`failed to read pending descendants during cancellation`,n,{sessionId:e.sessionState.sessionId});return}" +
      "let cancelDetached=()=>Promise.all(detachedChildren.map(e=>cancelLocalDescendant({action:{callId:e.callId,subagentName:e.subagentName},childSessionId:e.childSessionId})));" +
      "if(r===void 0)return void await cancelDetached();let i=r.childSessionIds;if(i===void 0)return void await cancelDetached();",
  },
  {
    file: "execution/cancel-descendant-turns-step.js",
    why: "(the pending batch's children and the detached ones are cancelled together)",
    find: ":[]});await Promise.all(o)}",
    replace: ":[]});await Promise.all([...o,cancelDetached()])}",
  },
  {
    file: "execution/settle-cancelled-turn-step.js",
    why: "imports",
    find: 'import{encodeMessageStreamEvent,timestampHandleMessageStreamEvent}from"#protocol/message.js";',
    replace:
      'import{createActionResultEvent,encodeMessageStreamEvent,timestampHandleMessageStreamEvent}from"#protocol/message.js";import{buildLateResultMessages,clearDetachedDelegations,createStoppedResult}from"#harness/detached-delegations.js";',
  },
  {
    file: "execution/settle-cancelled-turn-step.js",
    why: "settleCancelledTurnStep: the main thread was stopped, so were its detached delegations: each is closed on the stream (action.result: stopped) and in the history (the main agent reads it next turn); none is delivered later",
    find: "let d=reconcileSessionContinuationToken(a,setHarnessEmissionState(clearAllProxyInputRequests(",
    replace:
      "{let q=clearDetachedDelegations(l);if(q.records.length>0){let e=r.parentWritable.getWriter();try{for(let t of q.records){let n=await callAdapterEventHandler(o,createActionResultEvent({result:createStoppedResult(t),sequence:u.sequence,stepIndex:u.stepIndex,turnId:u.turnId}),s);setChannelContext(a,{...o,state:{...s.state}}),await e.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(n)))}}finally{e.releaseLock()}" +
      "l={...q.session,history:[...q.session.history,...buildLateResultMessages(q.records.map(e=>({record:e,result:createStoppedResult(e)})))]}}}" +
      "let d=reconcileSessionContinuationToken(a,setHarnessEmissionState(clearAllProxyInputRequests(",
  },


  /* ---- mold_v1-191: a step another invocation is running inline is not started again (eve's local world) -------- */
  {
    file: "compiled/@workflow/world-local/index.js",
    why: "step_started: a NON-inline start of a step that another invocation of this process started INLINE, within the runtime's own inline-ownership lease (WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS, 860 s), is refused as a conflict (the executor then skips it). Two invocations replaying one run at once (two hook payloads together: two results, a timer and a result) used to run the step twice — the model and every stream write twice (mold_v1-191). A crashed owner loses the note with its process.",
    find: "if(O){if(O.retryAfter&&O.retryAfter.getTime()>Date.now())throw new l(`Cannot start step",
    replace:
      "if(O&&!fe){let n=" + INL + ".get(`${C}-${i.correlationId}`),q=process.env.WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS,r=q===void 0||q===``||!Number.isInteger(Number(q))?860:Math.min(900,Math.max(1,Number(q)));if(n&&n.owner!==i.eventData?.ownerMessageId&&+g-n.at<r*1e3)throw new d(`Step \"${i.correlationId}\" is already running inline in another invocation`)}if(O){if(O.retryAfter&&O.retryAfter.getTime()>Date.now())throw new l(`Cannot start step",
  },
  {
    file: "compiled/@workflow/world-local/index.js",
    why: "(note an inline start once it is recorded)",
    find: "M={...O,status:`running`,startedAt:O.startedAt??g,attempt:O.attempt+1,retryAfter:void 0,updatedAt:g},await W(V(e,`steps`,n,t),M,{overwrite:!0})}}",
    replace:
      "M={...O,status:`running`,startedAt:O.startedAt??g,attempt:O.attempt+1,retryAfter:void 0,updatedAt:g},await W(V(e,`steps`,n,t),M,{overwrite:!0}),fe&&" + INL + ".set(n,{at:+g,owner:i.eventData?.ownerMessageId})}}",
  },
  {
    file: "compiled/@workflow/world-local/index.js",
    why: "(a completed step is no longer running)",
    find: "else if(i.eventType===`step_completed`&&`eventData`in i){",
    replace: "else if(i.eventType===`step_completed`&&`eventData`in i){" + INL + ".delete(`${C}-${i.correlationId}`);",
  },
  {
    file: "compiled/@workflow/world-local/index.js",
    why: "(nor a failed one)",
    find: "else if(i.eventType===`step_failed`&&`eventData`in i){",
    replace: "else if(i.eventType===`step_failed`&&`eventData`in i){" + INL + ".delete(`${C}-${i.correlationId}`);",
  },
  {
    file: "compiled/@workflow/world-local/index.js",
    why: "(nor one waiting to be retried: its retry must start)",
    find: "else if(i.eventType===`step_retrying`&&`eventData`in i){",
    replace: "else if(i.eventType===`step_retrying`&&`eventData`in i){" + INL + ".delete(`${C}-${i.correlationId}`);",
  },
];

/** Whole new files, copied from scripts/eve-patch/files/<path> to node_modules/eve/dist/src/<path>. */
export const NEW_FILES = ["harness/detached-delegations.js", "execution/parent-session-delivery.js"];
