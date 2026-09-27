// 把 pi 的内部事件流归一为 nx-as 的 span 树事件。
//
// nx-as 事件类型：
//   span_open  { spanId, parentId, spanType, name, input }
//   span_text  { spanId, delta }                  → 往 span 的 text 字段追加
//   span_data  { spanId, key, value }             → 往 span 的 attrs[key] 写
//   span_close { spanId, status, output?, usage? }
//
// pi 的事件类型（观察到的）：
//   message_update{ assistantMessageEvent: { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta', ... } }
//   message_start { message: { role, ... } }
//   tool_execution_start { toolName, args }
//   tool_execution_end   { toolName, result }
//   agent_start / agent_end / turn_start / turn_end
//
// 归一规则：
//   - turn_start → 开一个 turn span（id='turn-N'）
//   - message_start(assistant) → 在当前 turn 下开一个 llm_call span
//   - message_update(text_delta) → span_text 给当前 llm_call
//   - message_update(thinking_delta) → span_data('thinking', ...) 给当前 llm_call
//   - tool_execution_start → 在 turn 下开一个 tool span，记录 input=args
//   - tool_execution_end   → 关闭 tool span，记录 output=result
//   - agent_end            → 关闭当前 llm_call
//   - turn_end             → 关闭当前 turn

export function createNormalizer(taskId, emit) {
  let turnIndex = 0;
  // 当前正在开的 span 引用（嵌套）
  const stack = []; // [{ spanId, spanType }]
  // 已开 span 的 id 计数（保证唯一）
  let counter = 0;
  function nextId(prefix) { return `${prefix}-${++counter}`; }

  function openSpan({ spanType, name, parentId, input }) {
    const spanId = nextId(spanType);
    emit({ type: 'span_open', spanId, parentId: parentId ?? null, spanType, name, input });
    return spanId;
  }
  function closeSpan(spanId, { status = 'ok', output = null, usage = null } = {}) {
    emit({ type: 'span_close', spanId, status, output, usage });
  }
  function appendText(spanId, delta) { emit({ type: 'span_text', spanId, delta }); }
  function putData(spanId, key, value) { emit({ type: 'span_data', spanId, key, value }); }

  return {
    // 入口：pi 的事件 → nx-as 事件
    ingest(event) {
      switch (event.type) {
        case 'turn_start': {
          turnIndex++;
          const spanId = openSpan({
            spanType: 'turn',
            name: `turn ${turnIndex}`,
            parentId: null,
          });
          stack.push({ spanId, spanType: 'turn' });
          break;
        }
        case 'turn_end': {
          const cur = stack[stack.length - 1];
          if (cur?.spanType === 'turn') {
            closeSpan(cur.spanId, { status: 'ok' });
            stack.pop();
          }
          break;
        }
        case 'message_start': {
          // 只在 assistant 时开 llm_call；user 消息由 task_start span 持有
          if (event.message?.role === 'assistant') {
            const parent = stack[stack.length - 1];
            const spanId = openSpan({
              spanType: 'llm',
              name: 'assistant',
              parentId: parent?.spanId ?? null,
              input: event.message,
            });
            stack.push({ spanId, spanType: 'llm' });
          }
          break;
        }
        case 'message_update': {
          const inner = event.assistantMessageEvent;
          const cur = stack[stack.length - 1];
          if (!cur || cur.spanType !== 'llm') break;
          if (inner?.type === 'text_delta' && inner.delta) {
            appendText(cur.spanId, inner.delta);
          } else if (inner?.type === 'thinking_delta' && inner.delta) {
            putData(cur.spanId, 'thinking', inner.delta);
          }
          break;
        }
        case 'message_end': {
          // assistant 消息结束：按 stopReason 决定 llm span 的状态。
          // 模型错误（403/429 等）pi 不抛异常，而是产出 stopReason='error' 的消息——
          // 不在这里关，agent_end 会把它标成 ok，调试面板就看不出哪次调用失败了。
          const msg = event.message;
          if (msg?.role !== 'assistant') break;
          const cur = stack[stack.length - 1];
          if (!cur || cur.spanType !== 'llm' || cur.spanId === undefined) break;
          // 只关属于自己的 llm span（message_end 的 llm 在栈顶）
          const idx = stack.findIndex((x) => x.spanType === 'llm');
          if (idx === -1) break;
          const llm = stack[idx];
          const failed = msg.stopReason === 'error';
          closeSpan(llm.spanId, {
            status: failed ? 'error' : 'ok',
            output: failed ? (msg.errorMessage || '模型调用失败') : null,
            usage: msg.usage || null,
          });
          stack.splice(idx, 1);
          break;
        }
        case 'tool_execution_start': {
          const parent = stack[stack.length - 1];
          const spanId = openSpan({
            spanType: 'tool',
            name: `${event.toolName}`,
            parentId: parent?.spanId ?? null,
            input: event.args,
          });
          stack.push({ spanId, spanType: 'tool' });
          break;
        }
        case 'tool_execution_end': {
          // 关掉最近的 tool span
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].spanType === 'tool') {
              closeSpan(stack[i].spanId, {
                status: event.result?.isError ? 'error' : 'ok',
                output: event.result,
              });
              stack.splice(i, 1);
              break;
            }
          }
          break;
        }
        case 'agent_end': {
          // 关掉所有还开的 llm span（agent 周期结束）
          for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].spanType === 'llm') {
              closeSpan(stack[i].spanId, { status: 'ok' });
              stack.splice(i, 1);
            }
          }
          break;
        }
      }
    },
    // 异常关闭：把剩余栈都标 error 关掉（避免半开 span 永久泄漏）
    finalize({ error = null } = {}) {
      while (stack.length) {
        const cur = stack.pop();
        closeSpan(cur.spanId, { status: error ? 'error' : 'ok', output: error });
      }
    },
    // 调试：导出当前栈快照
    stack() { return stack.slice(); },
  };
}