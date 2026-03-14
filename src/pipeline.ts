/**
 * YAML pipeline executor.
 * Steps: fetch, navigate, evaluate, map, filter, sort, limit, select, snapshot, click, type, wait, press, intercept.
 */

import chalk from 'chalk';

export interface PipelineContext {
  args?: Record<string, any>;
  debug?: boolean;
}

export async function executePipeline(
  page: any,
  pipeline: any[],
  ctx: PipelineContext = {},
): Promise<any> {
  const args = ctx.args ?? {};
  const debug = ctx.debug ?? false;
  let data: any = null;
  const total = pipeline.length;

  for (let i = 0; i < pipeline.length; i++) {
    const step = pipeline[i];
    if (!step || typeof step !== 'object') continue;
    for (const [op, params] of Object.entries(step)) {
      if (debug) debugStepStart(i + 1, total, op, params);
      data = await executeStep(page, op, params, data, args);
      if (debug) debugStepResult(op, data);
    }
  }
  return data;
}

function normalizeEvaluateSource(source: string): string {
  const stripped = source.trim();
  if (!stripped) return '() => undefined';
  if (stripped.startsWith('(') && stripped.endsWith(')()')) return `() => (${stripped})`;
  if (/^(async\s+)?\([^)]*\)\s*=>/.test(stripped)) return stripped;
  if (/^(async\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=>/.test(stripped)) return stripped;
  if (stripped.startsWith('function ') || stripped.startsWith('async function ')) return stripped;
  return `() => (${stripped})`;
}

function debugStepStart(stepNum: number, total: number, op: string, params: any): void {
  let preview = '';
  if (typeof params === 'string') {
    preview = params.length <= 80 ? ` → ${params}` : ` → ${params.slice(0, 77)}...`;
  } else if (params && typeof params === 'object' && !Array.isArray(params)) {
    preview = ` (${Object.keys(params).join(', ')})`;
  }
  process.stderr.write(`  ${chalk.dim(`[${stepNum}/${total}]`)} ${chalk.bold.cyan(op)}${preview}\n`);
}

function debugStepResult(op: string, data: any): void {
  if (data === null || data === undefined) {
    process.stderr.write(`       ${chalk.dim('→ (no data)')}\n`);
  } else if (Array.isArray(data)) {
    process.stderr.write(`       ${chalk.dim(`→ ${data.length} items`)}\n`);
  } else if (typeof data === 'object') {
    const keys = Object.keys(data).slice(0, 5);
    process.stderr.write(`       ${chalk.dim(`→ dict (${keys.join(', ')}${Object.keys(data).length > 5 ? '...' : ''})`)}\n`);
  } else if (typeof data === 'string') {
    const p = data.slice(0, 60).replace(/\n/g, '\\n');
    process.stderr.write(`       ${chalk.dim(`→ "${p}${data.length > 60 ? '...' : ''}"`)}\n`);
  } else {
    process.stderr.write(`       ${chalk.dim(`→ ${typeof data}`)}\n`);
  }
}

// Single URL fetch helper
async function fetchSingle(
  page: any, url: string, method: string,
  queryParams: Record<string, any>, headers: Record<string, any>,
  args: Record<string, any>, data: any,
): Promise<any> {
  const renderedParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(queryParams)) renderedParams[k] = String(render(v, { args, data }));
  const renderedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) renderedHeaders[k] = String(render(v, { args, data }));

  let finalUrl = url;
  if (Object.keys(renderedParams).length > 0) {
    const qs = new URLSearchParams(renderedParams).toString();
    finalUrl = `${finalUrl}${finalUrl.includes('?') ? '&' : '?'}${qs}`;
  }

  if (page === null) {
    const resp = await fetch(finalUrl, { method: method.toUpperCase(), headers: renderedHeaders });
    return resp.json();
  }

  const headersJs = JSON.stringify(renderedHeaders);
  const escapedUrl = finalUrl.replace(/"/g, '\\"');
  return page.evaluate(`
    async () => {
      const resp = await fetch("${escapedUrl}", {
        method: "${method}", headers: ${headersJs}, credentials: "include"
      });
      return await resp.json();
    }
  `);
}

async function executeStep(page: any, op: string, params: any, data: any, args: Record<string, any>): Promise<any> {
  switch (op) {
    case 'navigate': {
      const url = render(params, { args, data });
      await page.goto(String(url));
      return data;
    }
    case 'fetch': {
      const urlOrObj = typeof params === 'string' ? params : (params?.url ?? '');
      const method = params?.method ?? 'GET';
      const queryParams: Record<string, any> = params?.params ?? {};
      const headers: Record<string, any> = params?.headers ?? {};
      const urlTemplate = String(urlOrObj);

      // Per-item fetch when data is array and URL references item
      if (Array.isArray(data) && urlTemplate.includes('item')) {
        const results: any[] = [];
        for (let i = 0; i < data.length; i++) {
          const itemUrl = String(render(urlTemplate, { args, data, item: data[i], index: i }));
          results.push(await fetchSingle(page, itemUrl, method, queryParams, headers, args, data));
        }
        return results;
      }
      const url = render(urlOrObj, { args, data });
      return fetchSingle(page, String(url), method, queryParams, headers, args, data);
    }
    case 'select': {
      const pathStr = String(render(params, { args, data }));
      if (data && typeof data === 'object') {
        let current = data;
        for (const part of pathStr.split('.')) {
          if (current && typeof current === 'object' && !Array.isArray(current)) current = (current as any)[part];
          else if (Array.isArray(current) && /^\d+$/.test(part)) current = current[parseInt(part, 10)];
          else return null;
        }
        return current;
      }
      return data;
    }
    case 'evaluate': {
      const js = String(render(params, { args, data }));
      let result = await page.evaluate(normalizeEvaluateSource(js));
      // MCP may return JSON as a string — auto-parse it
      if (typeof result === 'string') {
        const trimmed = result.trim();
        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
          try { result = JSON.parse(trimmed); } catch {}
        }
      }
      return result;
    }
    case 'snapshot': {
      const opts = (typeof params === 'object' && params) ? params : {};
      return page.snapshot({ interactive: opts.interactive ?? false, compact: opts.compact ?? false, maxDepth: opts.max_depth, raw: opts.raw ?? false });
    }
    case 'click': {
      await page.click(String(render(params, { args, data })).replace(/^@/, ''));
      return data;
    }
    case 'type': {
      if (typeof params === 'object' && params) {
        const ref = String(render(params.ref ?? '', { args, data })).replace(/^@/, '');
        const text = String(render(params.text ?? '', { args, data }));
        await page.typeText(ref, text);
        if (params.submit) await page.pressKey('Enter');
      }
      return data;
    }
    case 'wait': {
      if (typeof params === 'number') await page.wait(params);
      else if (typeof params === 'object' && params) {
        if ('text' in params) {
          const timeout = params.timeout ?? 10;
          const start = Date.now();
          while ((Date.now() - start) / 1000 < timeout) {
            const snap = await page.snapshot({ raw: true });
            if (typeof snap === 'string' && snap.includes(params.text)) break;
            await page.wait(0.5);
          }
        } else if ('time' in params) await page.wait(Number(params.time));
      } else if (typeof params === 'string') await page.wait(Number(render(params, { args, data })));
      return data;
    }
    case 'press': {
      await page.pressKey(String(render(params, { args, data })));
      return data;
    }
    case 'map': {
      if (!data || typeof data !== 'object') return data;
      let items: any[] = Array.isArray(data) ? data : [data];
      if (!Array.isArray(data) && typeof data === 'object' && 'data' in data) items = data.data;
      const result: any[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const row: Record<string, any> = {};
        for (const [key, template] of Object.entries(params)) row[key] = render(template, { args, data, item, index: i });
        result.push(row);
      }
      return result;
    }
    case 'filter': {
      if (!Array.isArray(data)) return data;
      return data.filter((item, i) => evalExpr(String(params), { args, item, index: i }));
    }
    case 'sort': {
      if (!Array.isArray(data)) return data;
      const key = typeof params === 'object' ? (params.by ?? '') : String(params);
      const reverse = typeof params === 'object' ? params.order === 'desc' : false;
      return [...data].sort((a, b) => { const va = a[key] ?? ''; const vb = b[key] ?? ''; const cmp = va < vb ? -1 : va > vb ? 1 : 0; return reverse ? -cmp : cmp; });
    }
    case 'limit': {
      if (!Array.isArray(data)) return data;
      return data.slice(0, Number(render(params, { args, data })));
    }
    case 'intercept': {
      // Declarative XHR interception step
      // Usage:
      //   intercept:
      //     trigger: "navigate:https://..." | "evaluate:store.note.fetch()" | "click:ref"
      //     capture: "api/pattern"     # URL substring to match
      //     timeout: 5                 # seconds to wait for matching request
      //     select: "data.items"       # optional: extract sub-path from response
      const cfg = typeof params === 'object' ? params : {};
      const trigger = cfg.trigger ?? '';
      const capturePattern = cfg.capture ?? '';
      const timeout = cfg.timeout ?? 8;
      const selectPath = cfg.select ?? null;

      if (!capturePattern) return data;

      // Step 1: Execute the trigger action
      if (trigger.startsWith('navigate:')) {
        const url = render(trigger.slice('navigate:'.length), { args, data });
        await page.goto(String(url));
      } else if (trigger.startsWith('evaluate:')) {
        const js = trigger.slice('evaluate:'.length);
        await page.evaluate(normalizeEvaluateSource(render(js, { args, data }) as string));
      } else if (trigger.startsWith('click:')) {
        const ref = render(trigger.slice('click:'.length), { args, data });
        await page.click(String(ref).replace(/^@/, ''));
      } else if (trigger === 'scroll') {
        await page.scroll('down');
      }

      // Step 2: Wait a bit for network requests to fire
      await page.wait(Math.min(timeout, 3));

      // Step 3: Get network requests and find matching ones
      const rawNetwork = await page.networkRequests(false);
      const matchingResponses: any[] = [];

      if (typeof rawNetwork === 'string') {
        // Parse the network output to find matching URLs
        const lines = rawNetwork.split('\n');
        for (const line of lines) {
          const match = line.match(/\[?(GET|POST)\]?\s+(\S+)\s*(?:=>|→)\s*\[?(\d+)\]?/i);
          if (match) {
            const [, method, url, status] = match;
            if (url.includes(capturePattern) && status === '200') {
              // Re-fetch the matching URL to get the response body
              try {
                const body = await page.evaluate(`
                  async () => {
                    try {
                      const resp = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
                      if (!resp.ok) return null;
                      return await resp.json();
                    } catch { return null; }
                  }
                `);
                if (body) matchingResponses.push(body);
              } catch {}
            }
          }
        }
      }

      // Step 4: Select from response if specified
      let result = matchingResponses.length === 1 ? matchingResponses[0] :
                   matchingResponses.length > 1 ? matchingResponses : data;

      if (selectPath && result) {
        let current = result;
        for (const part of String(selectPath).split('.')) {
          if (current && typeof current === 'object' && !Array.isArray(current)) {
            current = current[part];
          } else break;
        }
        result = current ?? result;
      }

      return result;
    }
    case 'tap': {
      // ── Declarative Store Action Bridge ──────────────────────────────────
      // Usage:
      //   tap:
      //     store: feed                 # Pinia/Vuex store name
      //     action: fetchFeeds          # Store action to call
      //     args: []                    # Optional args to pass to action
      //     capture: homefeed           # URL pattern to capture response
      //     timeout: 5                  # Seconds to wait for network (default: 5)
      //     select: data.items          # Optional: extract sub-path from response
      //     framework: pinia            # Optional: pinia | vuex (auto-detected if omitted)
      //
      // Generates a self-contained IIFE that:
      // 1. Injects fetch + XHR dual interception proxy
      // 2. Finds the Pinia/Vuex store and calls the action
      // 3. Captures the response matching the URL pattern
      // 4. Auto-cleans up interception in finally block
      // 5. Returns the captured data (optionally sub-selected)

      const cfg = typeof params === 'object' ? params : {};
      const storeName = String(render(cfg.store ?? '', { args, data }));
      const actionName = String(render(cfg.action ?? '', { args, data }));
      const capturePattern = String(render(cfg.capture ?? '', { args, data }));
      const timeout = cfg.timeout ?? 5;
      const selectPath = cfg.select ? String(render(cfg.select, { args, data })) : null;
      const framework = cfg.framework ?? null; // auto-detect if null
      const actionArgs = cfg.args ?? [];

      if (!storeName || !actionName) throw new Error('tap: store and action are required');

      // Build select chain for the captured response
      const selectChain = selectPath
        ? selectPath.split('.').map((p: string) => `?.[${JSON.stringify(p)}]`).join('')
        : '';

      // Serialize action arguments
      const actionArgsRendered = actionArgs.map((a: any) => {
        const rendered = render(a, { args, data });
        return JSON.stringify(rendered);
      });
      const actionCall = actionArgsRendered.length
        ? `store[${JSON.stringify(actionName)}](${actionArgsRendered.join(', ')})`
        : `store[${JSON.stringify(actionName)}]()`;

      const js = `
        async () => {
          // ── 1. Setup capture proxy (fetch + XHR dual interception) ──
          let captured = null;
          const capturePattern = ${JSON.stringify(capturePattern)};

          // Intercept fetch API
          const origFetch = window.fetch;
          window.fetch = async function(...fetchArgs) {
            const resp = await origFetch.apply(this, fetchArgs);
            try {
              const url = typeof fetchArgs[0] === 'string' ? fetchArgs[0]
                : fetchArgs[0] instanceof Request ? fetchArgs[0].url : String(fetchArgs[0]);
              if (capturePattern && url.includes(capturePattern) && !captured) {
                try { captured = await resp.clone().json(); } catch {}
              }
            } catch {}
            return resp;
          };

          // Intercept XMLHttpRequest
          const origXhrOpen = XMLHttpRequest.prototype.open;
          const origXhrSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__tapUrl = String(url);
            return origXhrOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function(body) {
            if (capturePattern && this.__tapUrl?.includes(capturePattern)) {
              const xhr = this;
              const origHandler = xhr.onreadystatechange;
              xhr.onreadystatechange = function() {
                if (xhr.readyState === 4 && !captured) {
                  try { captured = JSON.parse(xhr.responseText); } catch {}
                }
                if (origHandler) origHandler.apply(this, arguments);
              };
              // Also handle onload
              const origOnload = xhr.onload;
              xhr.onload = function() {
                if (!captured) { try { captured = JSON.parse(xhr.responseText); } catch {} }
                if (origOnload) origOnload.apply(this, arguments);
              };
            }
            return origXhrSend.apply(this, arguments);
          };

          try {
            // ── 2. Find store ──
            let store = null;
            const storeName = ${JSON.stringify(storeName)};
            const fw = ${JSON.stringify(framework)};

            // Auto-detect framework if not specified
            const app = document.querySelector('#app');
            if (!fw || fw === 'pinia') {
              // Try Pinia (Vue 3)
              try {
                const pinia = app?.__vue_app__?.config?.globalProperties?.$pinia;
                if (pinia?._s) store = pinia._s.get(storeName);
              } catch {}
            }
            if (!store && (!fw || fw === 'vuex')) {
              // Try Vuex (Vue 2/3)
              try {
                const vuexStore = app?.__vue_app__?.config?.globalProperties?.$store
                  ?? app?.__vue__?.$store;
                if (vuexStore) {
                  // Vuex doesn't have named stores like Pinia, dispatch action
                  store = { [${JSON.stringify(actionName)}]: (...a) => vuexStore.dispatch(storeName + '/' + ${JSON.stringify(actionName)}, ...a) };
                }
              } catch {}
            }

            if (!store) return { error: 'Store not found: ' + storeName, hint: 'Page may not be fully loaded or store name may be incorrect' };
            if (typeof store[${JSON.stringify(actionName)}] !== 'function') {
              return { error: 'Action not found: ' + ${JSON.stringify(actionName)} + ' on store ' + storeName,
                hint: 'Available: ' + Object.keys(store).filter(k => typeof store[k] === 'function' && !k.startsWith('$') && !k.startsWith('_')).join(', ') };
            }

            // ── 3. Call store action ──
            await ${actionCall};

            // ── 4. Wait for network response ──
            const deadline = Date.now() + ${timeout} * 1000;
            while (!captured && Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 200));
            }
          } finally {
            // ── 5. Always restore originals ──
            window.fetch = origFetch;
            XMLHttpRequest.prototype.open = origXhrOpen;
            XMLHttpRequest.prototype.send = origXhrSend;
          }

          if (!captured) return { error: 'No matching response captured for pattern: ' + capturePattern };
          return captured${selectChain} ?? captured;
        }
      `;

      return page.evaluate(js);
    }
    default: return data;
  }
}

// Template engine: ${{ ... }}
interface RenderContext { args?: Record<string, any>; data?: any; item?: any; index?: number; }

function render(template: any, ctx: RenderContext): any {
  if (typeof template !== 'string') return template;
  const fullMatch = template.match(/^\$\{\{\s*(.*?)\s*\}\}$/);
  if (fullMatch) return evalExpr(fullMatch[1].trim(), ctx);
  return template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_m, expr) => String(evalExpr(expr.trim(), ctx)));
}

function evalExpr(expr: string, ctx: RenderContext): any {
  const args = ctx.args ?? {};
  const item = ctx.item ?? {};
  const data = ctx.data;
  const index = ctx.index ?? 0;

  // Default filter: args.limit | default(20)
  if (expr.includes('|') && expr.includes('default(')) {
    const [mainExpr, rest] = expr.split('|', 2);
    const defaultMatch = rest.match(/default\((.+?)\)/);
    const defaultVal = defaultMatch ? defaultMatch[1] : null;
    const result = resolvePath(mainExpr.trim(), { args, item, data, index });
    if (result === null || result === undefined) {
      if (defaultVal !== null) {
        const intVal = parseInt(defaultVal!, 10);
        if (!isNaN(intVal) && String(intVal) === defaultVal!.trim()) return intVal;
        return defaultVal!.replace(/^['"]|['"]$/g, '');
      }
    }
    return result;
  }

  // Arithmetic: index + 1
  const arithMatch = expr.match(/^([\w][\w.]*)\s*([+\-*/])\s*(\d+)$/);
  if (arithMatch) {
    const [, varName, op, numStr] = arithMatch;
    const val = resolvePath(varName, { args, item, data, index });
    if (val !== null && val !== undefined) {
      const numVal = Number(val); const num = Number(numStr);
      if (!isNaN(numVal)) {
        switch (op) {
          case '+': return numVal + num; case '-': return numVal - num;
          case '*': return numVal * num; case '/': return num !== 0 ? numVal / num : 0;
        }
      }
    }
  }

  // JS-like fallback expression: item.tweetCount || 'N/A'
  const orMatch = expr.match(/^(.+?)\s*\|\|\s*(.+)$/);
  if (orMatch) {
    const left = evalExpr(orMatch[1].trim(), ctx);
    if (left) return left;
    const right = orMatch[2].trim();
    return right.replace(/^['"]|['"]$/g, '');
  }

  return resolvePath(expr, { args, item, data, index });
}

function resolvePath(pathStr: string, ctx: RenderContext): any {
  const args = ctx.args ?? {};
  const item = ctx.item ?? {};
  const data = ctx.data;
  const index = ctx.index ?? 0;
  const parts = pathStr.split('.');
  const rootName = parts[0];
  let obj: any; let rest: string[];
  if (rootName === 'args') { obj = args; rest = parts.slice(1); }
  else if (rootName === 'item') { obj = item; rest = parts.slice(1); }
  else if (rootName === 'data') { obj = data; rest = parts.slice(1); }
  else if (rootName === 'index') return index;
  else { obj = item; rest = parts; }
  for (const part of rest) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) obj = obj[part];
    else if (Array.isArray(obj) && /^\d+$/.test(part)) obj = obj[parseInt(part, 10)];
    else return null;
  }
  return obj;
}
