/* ============================================================
   Atelier Plans runtime
   Handles: TOC, edit mode, persistence, code highlight,
            mermaid, task/status cycling, export, copy-diff.
   ============================================================ */

(function () {
  'use strict';

  // ---------- toast ----------
  let toastHost;
  function toast(msg, ms = 1800) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      document.body.appendChild(toastHost);
    }
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastHost.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------- storage ----------
  const storageKey = () => 'atelier-plan:' + (location.pathname || '/');
  function loadState() {
    try { return JSON.parse(localStorage.getItem(storageKey()) || '{}'); }
    catch { return {}; }
  }
  function saveState(s) {
    try { localStorage.setItem(storageKey(), JSON.stringify(s)); } catch {}
  }
  const state = loadState();
  function patch(key, val) {
    state[key] = val;
    saveState(state);
  }

  // ---------- section numbering + TOC ----------
  function buildTOC() {
    const doc = document.querySelector('.doc');
    if (!doc) return;
    const rail = document.querySelector('.rail-toc');
    if (!rail) return;
    const headings = doc.querySelectorAll('h2');
    const ol = document.createElement('ol');
    headings.forEach((h, i) => {
      const n = String(i + 1).padStart(2, '0');
      h.dataset.num = n;
      if (!h.id) h.id = 'sec-' + n + '-' + slug(h.textContent);
      const li = document.createElement('li');
      const a  = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent.trim();
      li.appendChild(a);
      // sub-TOC for h3s if section is dense
      const sec = h.closest('section') || h.parentElement;
      const subs = sec ? sec.querySelectorAll(':scope > h3') : [];
      if (subs.length >= 3) {
        const subOl = document.createElement('ol');
        subOl.className = 'rail-sub';
        subs.forEach(sub => {
          if (!sub.id) sub.id = 'sub-' + slug(sub.textContent);
          const subLi = document.createElement('li');
          const subA = document.createElement('a');
          subA.href = '#' + sub.id;
          subA.textContent = sub.textContent.trim();
          subLi.appendChild(subA);
          subOl.appendChild(subLi);
        });
        li.appendChild(subOl);
      }
      ol.appendChild(li);
    });
    rail.appendChild(ol);

    // active-on-scroll
    const links = rail.querySelectorAll('a');
    const byId = {};
    links.forEach(a => byId[a.getAttribute('href').slice(1)] = a);
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        const a = byId[e.target.id];
        if (!a) return;
        if (e.isIntersecting) {
          links.forEach(l => l.classList.remove('active'));
          a.classList.add('active');
        }
      });
    }, { rootMargin: '-30% 0px -65% 0px' });
    headings.forEach(h => io.observe(h));
  }

  function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  }

  // ---------- reading progress ----------
  function buildProgress() {
    const rail = document.querySelector('.rail-toc');
    if (!rail) return;
    const wrap = document.createElement('div');
    wrap.className = 'rail-progress';
    const bar = document.createElement('div');
    wrap.appendChild(bar);
    rail.appendChild(wrap);
    function tick() {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const pct = max > 0 ? Math.min(100, (h.scrollTop / max) * 100) : 0;
      bar.style.width = pct.toFixed(1) + '%';
    }
    document.addEventListener('scroll', tick, { passive: true });
    tick();
  }

  // ---------- edit mode ----------
  let editOn = state.edit !== false; // default ON
  const EDITABLE_SEL = '.doc h1, .doc h2, .doc h3, .doc h4, .doc p, .doc li, .doc blockquote, .doc td, .doc th, .doc .callout-body, .decision-title, .phase .phase-title, .doc-title, .doc-summary, .task-text';

  function wireEditable() {
    document.querySelectorAll(EDITABLE_SEL).forEach(el => {
      if (el.closest('.code-block, pre, .mermaid, .rail, .topbar, .doc-footer')) return;
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'true');
    });
    // restore saved edits
    if (state.edits) {
      Object.entries(state.edits).forEach(([k, v]) => {
        const el = document.querySelector('[data-edit-id="' + k + '"]');
        if (el) el.innerHTML = v;
      });
    }
    // capture changes
    document.addEventListener('input', (e) => {
      const el = e.target.closest('[contenteditable="true"]');
      if (!el) return;
      const id = ensureEditId(el);
      const edits = state.edits || {};
      edits[id] = el.innerHTML;
      patch('edits', edits);
    });
  }
  let editIdCounter = 0;
  function ensureEditId(el) {
    if (!el.dataset.editId) {
      // stable-ish id from path + ordinal
      const path = [];
      let cur = el;
      while (cur && cur !== document.body) {
        const p = cur.parentElement;
        if (!p) break;
        const i = Array.from(p.children).indexOf(cur);
        path.unshift(cur.tagName + i);
        cur = p;
      }
      el.dataset.editId = path.join('>');
    }
    return el.dataset.editId;
  }

  function setEditMode(on) {
    editOn = on;
    document.body.classList.toggle('edit-off', !on);
    patch('edit', on);
    const btn = document.querySelector('[data-action="toggle-edit"]');
    if (btn) btn.textContent = on ? 'Edit · on' : 'Edit · off';
  }

  // ---------- task & status cycling ----------
  const TASK_CYCLE = ['todo', 'doing', 'done', 'blocked'];
  const STATUS_CYCLE = ['draft', 'in-review', 'approved', 'shipped', 'blocked'];

  function wireTasks() {
    document.querySelectorAll('.tasks li').forEach((li, i) => {
      if (!li.dataset.status) li.dataset.status = 'todo';
      if (!li.dataset.taskId) li.dataset.taskId = 't' + i;
      const saved = (state.tasks || {})[li.dataset.taskId];
      if (saved) li.dataset.status = saved;
      const check = li.querySelector('.task-check');
      if (check) {
        check.setAttribute('role', 'checkbox');
        check.setAttribute('tabindex', '0');
        check.addEventListener('click', (e) => {
          if (!editOn) return;
          const cur = li.dataset.status || 'todo';
          const next = TASK_CYCLE[(TASK_CYCLE.indexOf(cur) + 1) % TASK_CYCLE.length];
          li.dataset.status = next;
          const tasks = state.tasks || {};
          tasks[li.dataset.taskId] = next;
          patch('tasks', tasks);
          e.stopPropagation();
        });
      }
    });

    document.querySelectorAll('.status[data-editable]').forEach((s, i) => {
      if (!s.dataset.statusId) s.dataset.statusId = 's' + i;
      const saved = (state.statuses || {})[s.dataset.statusId];
      if (saved) s.dataset.status = saved;
      // refresh label text node
      refreshStatusLabel(s);
      s.addEventListener('click', () => {
        if (!editOn) return;
        const cur = s.dataset.status || 'draft';
        const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(cur) + 1) % STATUS_CYCLE.length];
        s.dataset.status = next;
        refreshStatusLabel(s);
        const statuses = state.statuses || {};
        statuses[s.dataset.statusId] = next;
        patch('statuses', statuses);
      });
    });
  }
  function refreshStatusLabel(s) {
    // find or create the trailing text node after the ::before dot
    let txt = Array.from(s.childNodes).find(n => n.nodeType === 3);
    if (!txt) {
      txt = document.createTextNode('');
      s.appendChild(txt);
    }
    txt.nodeValue = s.dataset.status.replace(/-/g, ' ');
  }

  // ---------- collapsible sections ----------
  function wireCollapsible() {
    document.querySelectorAll('section.collapsible > h2').forEach(h => {
      h.addEventListener('click', (e) => {
        // only collapse when the click is on the heading background, not the editable text
        if (e.target !== h) return;
        h.parentElement.classList.toggle('collapsed');
      });
    });
  }

  // ---------- code blocks: copy + filename + lang ----------
  function wireCode() {
    document.querySelectorAll('.code-block').forEach(block => {
      const head = block.querySelector('.code-head');
      if (head && !head.querySelector('.copy')) {
        const btn = document.createElement('button');
        btn.className = 'btn ghost copy';
        btn.type = 'button';
        btn.textContent = 'copy';
        btn.dataset.editOnly = '';
        btn.addEventListener('click', () => {
          const pre = block.querySelector('pre');
          if (!pre) return;
          navigator.clipboard.writeText(pre.innerText).then(() => {
            btn.textContent = 'copied';
            setTimeout(() => btn.textContent = 'copy', 1400);
          });
        });
        head.appendChild(btn);
      }
    });
  }

  // ---------- mermaid lazy init ----------
  function captureMermaidSource() {
    document.querySelectorAll('pre.mermaid').forEach(el => {
      if (!el.dataset.mermaidSource) {
        el.dataset.mermaidSource = el.textContent;
      }
    });
  }
  function initMermaid() {
    const blocks = document.querySelectorAll('.mermaid');
    if (!blocks.length || !window.mermaid) return;
    captureMermaidSource();
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      fontFamily: "Geist, -apple-system, sans-serif",
      themeVariables: {
        background: '#F7F4EE',
        primaryColor: '#EFEAE0',
        primaryTextColor: '#1E1B16',
        primaryBorderColor: '#B8B0A0',
        lineColor: '#6C6557',
        secondaryColor: '#D6E0D9',
        tertiaryColor: '#F1D4C5',
        clusterBkg: '#EFEAE0',
        clusterBorder: '#D6CFBE',
        edgeLabelBackground: '#F7F4EE',
        nodeTextColor: '#1E1B16',
        actorBkg: '#F1D4C5',
        actorBorder: '#B8462B',
        actorTextColor: '#1E1B16',
        labelBoxBkgColor: '#EFEAE0',
        labelBoxBorderColor: '#D6CFBE',
        noteBkgColor: '#EDDFBE',
        noteBorderColor: '#E0C988',
      }
    });
    window.mermaid.run({ querySelector: '.mermaid' }).catch(err => console.error('mermaid:', err));
  }

  // ---------- prism lazy init ----------
  function initPrism() {
    if (window.Prism) window.Prism.highlightAll();
  }

  // ---------- export & diff ----------
  function exportHTML() {
    const clone = document.documentElement.cloneNode(true);
    // strip transient classes & runtime attributes from the clone
    clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
    clone.querySelectorAll('[spellcheck]').forEach(el => el.removeAttribute('spellcheck'));
    clone.querySelectorAll('.toast-host').forEach(el => el.remove());
    clone.querySelector('body')?.classList.remove('edit-off');
    const html = '<!doctype html>\n' + clone.outerHTML;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (document.title || 'plan') + '.html';
    a.click();
    URL.revokeObjectURL(url);
    toast('Downloaded edited plan');
  }

  function copyForClaudeCode() {
    // human-readable changeset for paste-back to Claude Code
    const lines = ['# Edits to apply (Atelier Plans)'];
    lines.push('# Source: ' + (location.pathname || ''));
    lines.push('# Generated: ' + new Date().toISOString());
    lines.push('');
    const edits = state.edits || {};
    Object.entries(edits).forEach(([id, html]) => {
      const el = document.querySelector('[data-edit-id="' + id + '"]');
      if (!el) return;
      const tag = el.tagName.toLowerCase();
      const label = el.closest('section')?.querySelector('h2')?.textContent?.trim() || '(top)';
      lines.push('--- ' + label + ' / ' + tag + ' ---');
      lines.push(stripHTML(html));
      lines.push('');
    });
    const tasks = state.tasks || {};
    if (Object.keys(tasks).length) {
      lines.push('## Task status changes');
      Object.entries(tasks).forEach(([k, v]) => {
        const el = document.querySelector('[data-task-id="' + k + '"]');
        const txt = el?.querySelector('.task-text')?.textContent?.trim() || k;
        lines.push('- [' + v + '] ' + txt);
      });
      lines.push('');
    }
    const statuses = state.statuses || {};
    if (Object.keys(statuses).length) {
      lines.push('## Status changes');
      Object.entries(statuses).forEach(([k, v]) => lines.push('- ' + k + ': ' + v));
    }
    const out = lines.join('\n');
    navigator.clipboard.writeText(out).then(() => toast('Copied edits. Paste to Claude Code.'));
  }

  function stripHTML(s) {
    const d = document.createElement('div');
    d.innerHTML = s;
    return d.textContent.replace(/\s+/g, ' ').trim();
  }

  // ---------- markdown export ----------
  function exportMarkdown() {
    const out = [];

    // ----- YAML frontmatter from .doc-header metadata -----
    const fm = {};
    const title = qText('.doc-title');
    const summary = qText('.doc-summary');
    if (title)   fm.title = title;
    if (summary) fm.summary = summary;

    // eyebrow: "Feature design · RFC-014" + status pill
    const eyebrowText = document.querySelector('.doc-eyebrow > span:nth-of-type(1)')?.textContent?.trim();
    if (eyebrowText) fm.kind = eyebrowText;
    const headerStatus = document.querySelector('.doc-header .status');
    if (headerStatus?.dataset?.status) fm.status = headerStatus.dataset.status;

    // meta dl rows
    document.querySelectorAll('.doc-meta > div').forEach(d => {
      const dt = d.querySelector('dt')?.textContent.trim().toLowerCase();
      const dd = d.querySelector('dd');
      if (!dt || !dd) return;
      const tags = dd.querySelectorAll('.tag');
      if (tags.length) {
        fm[dt] = Array.from(tags).map(t => t.textContent.trim());
      } else {
        const links = dd.querySelectorAll('a');
        if (links.length > 1) fm[dt] = Array.from(links).map(a => a.textContent.trim());
        else fm[dt] = dd.textContent.replace(/\s+/g, ' ').trim();
      }
    });

    if (Object.keys(fm).length) {
      out.push('---');
      for (const [k, v] of Object.entries(fm)) {
        if (Array.isArray(v)) {
          out.push(k + ': [' + v.map(yamlScalar).join(', ') + ']');
        } else {
          out.push(k + ': ' + yamlScalar(v));
        }
      }
      out.push('---', '');
    }

    // ----- body -----
    if (title) out.push('# ' + title, '');
    if (summary) out.push('_' + summary + '_', '');

    document.querySelectorAll('.doc > section').forEach(sec => {
      sectionToMd(sec).forEach(l => out.push(l));
    });

    // dedupe consecutive blanks
    return out.filter((l, i, a) => !(l === '' && a[i-1] === '')).join('\n').trim() + '\n';
  }

  function qText(sel) {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function yamlScalar(v) {
    if (v == null) return '""';
    const s = String(v);
    if (s === '') return '""';
    if (/^[a-zA-Z0-9_\-.@/ ]+$/.test(s)
        && !/^(true|false|null|yes|no|on|off)$/i.test(s)
        && !/^[\d\-]/.test(s)) {
      return s;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // bare date
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function sectionToMd(sec) {
    const out = [];
    const h2 = sec.querySelector(':scope > h2');
    if (h2) {
      const n = h2.dataset.num;
      const t = textOf(h2);
      out.push('', (n ? '## ' + n + '. ' + t : '## ' + t), '');
    }
    Array.from(sec.children).forEach(node => {
      if (node === h2) return;
      nodeToMd(node).forEach(l => out.push(l));
    });
    return out;
  }

  function textOf(el) { return el.textContent.replace(/\s+/g, ' ').trim(); }

  function nodeToMd(el) {
    if (!el || el.nodeType !== 1) return [];

    if (el.matches('.callout'))      return calloutToMd(el);
    if (el.matches('.decision'))     return decisionToMd(el);
    if (el.matches('.changeset'))    return changesetToMd(el);
    if (el.matches('.journey'))      return journeyToMd(el);
    if (el.matches('.amendment'))    return amendmentToMd(el);
    if (el.matches('.relations'))    return relationsToMd(el);
    if (el.matches('ul.id-list, ol.id-list')) return idListToMd(el);
    if (el.matches('ol.prompt-stack, ul.prompt-stack')) return promptStackToMd(el);
    if (el.matches('ol.tasks, ul.tasks')) return tasksToMd(el);
    if (el.matches('.phases'))       return phasesToMd(el);
    if (el.matches('details.diff'))  return diffToMd(el);
    if (el.matches('.code-block'))   return codeBlockToMd(el);
    if (el.matches('figure.diagram, figure.figure')) return figureToMd(el);
    if (el.matches('.matrix'))       return matrixToMd(el);
    if (el.matches('pre.mermaid'))   return fence(el.dataset.mermaidSource || el.textContent, 'mermaid');
    if (el.matches('pre.ascii'))     return fence(el.textContent, '');

    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'h3': return ['', '### ' + inlineMd(el), ''];
      case 'h4': return ['', '#### ' + inlineMd(el), ''];
      case 'p': {
        if (el.classList.contains('lede')) return ['', '> _' + inlineMd(el) + '_', ''];
        return [inlineMd(el), ''];
      }
      case 'ul': {
        const out = [];
        el.querySelectorAll(':scope > li').forEach(li => out.push('- ' + inlineMd(li)));
        out.push('');
        return out;
      }
      case 'ol': {
        const out = []; let i = 1;
        el.querySelectorAll(':scope > li').forEach(li => out.push((i++) + '. ' + inlineMd(li)));
        out.push('');
        return out;
      }
      case 'blockquote': {
        const out = [''];
        inlineMd(el).split('\n').forEach(line => out.push('> ' + line));
        out.push('');
        return out;
      }
      case 'table': return tableToMd(el);
      case 'hr':    return ['', '---', ''];
      case 'pre':   return fence(el.textContent, '');
      case 'section': return sectionToMd(el);
      default: {
        const out = [];
        Array.from(el.children).forEach(c => nodeToMd(c).forEach(l => out.push(l)));
        return out;
      }
    }
  }

  function inlineMd(el) {
    let s = '';
    el.childNodes.forEach(n => {
      if (n.nodeType === 3) { s += n.textContent; return; }
      if (n.nodeType !== 1) return;
      const t = n.tagName.toLowerCase();
      const inner = inlineMd(n);
      switch (t) {
        case 'strong': case 'b': s += '**' + inner + '**'; break;
        case 'em': case 'i':     s += '_' + inner + '_'; break;
        case 'code':             s += '`' + n.textContent + '`'; break;
        case 'a': {
          // xref-style links render bare in markdown
          if (n.classList.contains('xref')) {
            s += '`§' + (inner.replace(/^§/, '')) + '`';
          } else {
            s += '[' + inner + '](' + (n.getAttribute('href') || '#') + ')';
          }
          break;
        }
        case 'br':               s += '  \n'; break;
        case 'span': case 'time':case 'small': s += inner; break;
        default:                 s += inner;
      }
    });
    return s.replace(/[ \t]+/g, ' ').replace(/\n /g, '\n').trim();
  }

  function idListToMd(el) {
    const out = [''];
    const kind = el.dataset.kind || '';
    el.querySelectorAll(':scope > li').forEach(li => {
      const tag = li.querySelector('.id-tag')?.textContent.trim() || '';
      const body = li.querySelector('.id-body');
      const text = body ? inlineMd(body) : inlineMd(li);
      out.push('- **' + tag + (kind ? ' (' + kind + ')' : '') + '.** ' + text);
    });
    out.push('');
    return out;
  }

  function journeyToMd(el) {
    const out = [''];
    const id = el.querySelector('.journey-id')?.textContent.trim() || '';
    const title = el.querySelector('.journey-title')?.textContent.trim() || '';
    out.push('### ' + (id ? id + ': ' : '') + title, '');
    el.querySelectorAll('.journey-body > section').forEach(section => {
      const h = section.querySelector('h4');
      if (h) out.push('**' + h.textContent.trim() + '**', '');
      const isSteps = section.querySelector('.journey-steps');
      if (isSteps) {
        section.querySelectorAll('.journey-steps > li').forEach(li => {
          out.push('- [ ] ' + inlineMd(li));
        });
      } else {
        section.querySelectorAll('ul li, ol li').forEach(li => {
          out.push('- ' + inlineMd(li));
        });
      }
      out.push('');
    });
    return out;
  }

  function amendmentToMd(el) {
    const label = el.querySelector('.amendment-label')?.textContent.trim() || 'Amended';
    const body = el.querySelector('p');
    return ['', '> **' + label + ':** ' + (body ? inlineMd(body) : ''), ''];
  }

  function relationsToMd(el) {
    const out = [''];
    el.querySelectorAll('.relation').forEach(r => {
      const label = r.querySelector('.relation-label')?.textContent.trim() || '';
      const body  = r.querySelector('.relation-body');
      if (body) out.push('- **' + label + ':** ' + inlineMd(body));
    });
    out.push('');
    return out;
  }

  function promptStackToMd(el) {
    const out = ['', '**Composed stack** (registration order):', ''];
    el.querySelectorAll(':scope > li').forEach((li, i) => {
      const tag = li.querySelector('.stack-tag')?.textContent.trim() || '';
      const body = li.querySelector('.stack-body');
      const state = li.dataset.state || '';
      out.push((i + 1) + '. `<' + tag + '>`: ' + (body ? inlineMd(body) : '') + (state ? ' _(' + state + ')_' : ''));
    });
    out.push('');
    return out;
  }

  function calloutToMd(el) {
    const kind  = (el.dataset.kind || 'note').toUpperCase();
    const label = el.querySelector('.callout-label')?.textContent.trim() || kind;
    const map = { goal: 'TIP', 'non-goal': 'NOTE', question: 'IMPORTANT', assumption: 'NOTE',
                  risk: 'CAUTION', key: 'IMPORTANT', note: 'NOTE' };
    const gh = map[(el.dataset.kind || 'note')] || 'NOTE';
    const out = ['', '> [!' + gh + '] ' + label];
    const body = el.querySelector('.callout-body');
    if (body) {
      const inner = [];
      Array.from(body.children).forEach(c => nodeToMd(c).forEach(l => inner.push(l)));
      inner.forEach(l => out.push(l === '' ? '>' : '> ' + l));
    }
    out.push('');
    return out;
  }

  function decisionToMd(el) {
    const id    = el.querySelector('.decision-id')?.textContent.trim() || '';
    const title = el.querySelector('.decision-title')?.textContent.trim() || '';
    const stat  = el.querySelector('.status')?.dataset?.status || '';
    const out = ['', '### ' + (id ? id + ': ' : '') + title];
    if (stat) out.push('', '_Status: ' + stat + '_');
    out.push('');
    el.querySelectorAll(':scope > p').forEach(p => out.push(inlineMd(p), ''));
    const meta = el.querySelector('.decision-meta');
    if (meta) {
      meta.querySelectorAll('dt').forEach(dt => {
        const dd = dt.nextElementSibling;
        if (dd) out.push('- **' + dt.textContent.trim() + ':** ' + dd.textContent.replace(/\s+/g, ' ').trim());
      });
      out.push('');
    }
    return out;
  }

  function changesetToMd(el) {
    const out = ['', '**Changeset**', ''];
    el.querySelectorAll('ul.tree > li').forEach(li => {
      const op = li.dataset.op;
      const sym = op === 'add' ? '+' : op === 'del' ? '−' : '~';
      const path = li.querySelector('.path')?.textContent.trim() || '';
      const note = li.querySelector('.note')?.textContent.trim() || '';
      out.push('- `' + sym + ' ' + path + '`' + (note ? ': ' + note : ''));
    });
    out.push('');
    return out;
  }

  function tasksToMd(el) {
    const out = [''];
    el.querySelectorAll(':scope > li').forEach(li => {
      const status = li.dataset.status || 'todo';
      const box = status === 'done' ? 'x' : status === 'doing' ? '·' : status === 'blocked' ? '!' : ' ';
      const text   = li.querySelector('.task-text')?.textContent.replace(/\s+/g, ' ').trim() || '';
      const owner  = li.querySelector('.task-owner')?.textContent.trim() || '';
      const est    = li.querySelector('.task-est')?.textContent.trim() || '';
      const tail = [];
      if (status !== 'todo' && status !== 'done') tail.push(status);
      if (owner) tail.push(owner);
      if (est && est !== '-') tail.push(est);
      out.push('- [' + box + '] ' + text + (tail.length ? ' _(' + tail.join(' · ') + ')_' : ''));
    });
    out.push('');
    return out;
  }

  function phasesToMd(el) {
    const out = ['', '**Phases**', ''];
    el.querySelectorAll('.phase').forEach(p => {
      const label = p.querySelector('.phase-label')?.textContent.trim();
      const title = p.querySelector('.phase-title')?.textContent.trim();
      const state = p.dataset.state || '';
      out.push('- **' + label + ': ' + title + '** _(' + state + ')_');
      p.querySelectorAll('ul li').forEach(li => out.push('  - ' + li.textContent.trim()));
    });
    out.push('');
    return out;
  }

  function diffToMd(el) {
    const summary = el.querySelector('summary')?.textContent.trim() || 'diff';
    const out = ['', '**' + summary + '**', '', '```diff'];
    el.querySelectorAll('.line').forEach(l => {
      const sym = l.classList.contains('add') ? '+' : l.classList.contains('del') ? '-' : ' ';
      out.push(sym + l.textContent);
    });
    out.push('```', '');
    return out;
  }

  function codeBlockToMd(el) {
    const filename = el.querySelector('.filename')?.textContent.trim() || '';
    const lang = el.querySelector('.lang')?.textContent.trim().toLowerCase() || '';
    const code = el.querySelector('pre')?.textContent || '';
    const out = [''];
    if (filename) out.push('**' + filename + '**', '');
    out.push('```' + lang, code.replace(/\n+$/, ''), '```', '');
    return out;
  }

  function figureToMd(el) {
    const out = [''];
    const captionEl = el.querySelector('.figure-caption, .caption, figcaption');
    const caption = captionEl?.textContent.replace(/\s+/g, ' ').trim();
    Array.from(el.children).forEach(n => {
      if (n === captionEl) return;
      if (n.matches('pre.mermaid')) out.push('```mermaid', (n.dataset.mermaidSource || n.textContent).trim(), '```');
      else if (n.matches('pre.ascii')) out.push('```', n.textContent.replace(/\n+$/, ''), '```');
      else if (n.matches('pre'))    out.push('```', n.textContent.replace(/\n+$/, ''), '```');
      else if (n.tagName === 'SVG' || n.querySelector?.('svg')) {
        out.push('<!-- inline SVG illustration (preserved as HTML) -->');
        out.push(n.outerHTML);
      }
      else nodeToMd(n).forEach(l => out.push(l));
    });
    if (caption) out.push('', '_Figure. ' + caption + '_');
    out.push('');
    return out;
  }

  function matrixToMd(el) {
    const out = ['', '**Matrix**', ''];
    const cells = el.querySelectorAll('.cell');
    const xs = Array.from(el.querySelectorAll('.axis-x')).map(a => a.textContent.trim());
    const ys = Array.from(el.querySelectorAll('.axis-y')).map(a => a.textContent.trim());
    out.push('|   | ' + xs.join(' | ') + ' |');
    out.push('|---|' + xs.map(() => '---|').join(''));
    for (let r = 0; r < ys.length; r++) {
      const row = ['**' + ys[r] + '**'];
      for (let c = 0; c < xs.length; c++) {
        const cell = cells[r * xs.length + c];
        if (!cell) { row.push(''); continue; }
        const lbl = cell.querySelector('.cell-label')?.textContent.trim() || '';
        const txt = Array.from(cell.querySelectorAll('p')).map(p => p.textContent.trim()).join(' ');
        row.push((lbl ? '_' + lbl + '_ ' : '') + txt);
      }
      out.push('| ' + row.join(' | ') + ' |');
    }
    out.push('');
    return out;
  }

  function tableToMd(el) {
    const out = [''];
    const headers = Array.from(el.querySelectorAll('thead th')).map(th => th.textContent.trim());
    if (headers.length) {
      out.push('| ' + headers.join(' | ') + ' |');
      out.push('|' + headers.map(() => '---').join('|') + '|');
    }
    el.querySelectorAll('tbody tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('td')).map(td =>
        td.textContent.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());
      out.push('| ' + cells.join(' | ') + ' |');
    });
    out.push('');
    return out;
  }

  function fence(text, lang) {
    return ['', '```' + (lang || ''), text.replace(/\n+$/, ''), '```', ''];
  }

  function copyMarkdown() {
    const md = exportMarkdown();
    navigator.clipboard.writeText(md).then(() => toast('Copied as markdown'));
  }

  function resetEdits() {
    if (!confirm('Discard all browser edits and reload the original?')) return;
    localStorage.removeItem(storageKey());
    location.reload();
  }

  // ---------- dropdown menu ----------
  function wireMenus() {
    document.querySelectorAll('[data-menu]').forEach(wrap => {
      const toggle = wrap.querySelector('[data-menu-toggle]');
      if (!toggle) return;
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = wrap.classList.contains('open');
        document.querySelectorAll('[data-menu].open').forEach(w => w.classList.remove('open'));
        if (!wasOpen) wrap.classList.add('open');
      });
      wrap.querySelectorAll('.btn-menu button').forEach(b => {
        b.addEventListener('click', () => setTimeout(() => wrap.classList.remove('open'), 0));
      });
    });
    document.addEventListener('click', () => {
      document.querySelectorAll('[data-menu].open').forEach(w => w.classList.remove('open'));
    });
  }

  // ---------- top bar wiring ----------
  function wireTopbar() {
    document.querySelectorAll('[data-action]').forEach(btn => {
      const a = btn.dataset.action;
      btn.addEventListener('click', () => {
        if (a === 'toggle-edit')      setEditMode(!editOn);
        else if (a === 'export-html') exportHTML();
        else if (a === 'copy-diff')   copyForClaudeCode();
        else if (a === 'copy-md')     copyMarkdown();
        else if (a === 'reset-edits') resetEdits();
        else if (a === 'print')       window.print();
      });
    });
  }

  // ---------- keyboard shortcuts ----------
  function wireKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('[contenteditable="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'e') { e.preventDefault(); setEditMode(!editOn); }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); exportHTML(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'p' && e.shiftKey) { e.preventDefault(); window.print(); }
    });
  }

  // ---------- diagram helper: sparkline ----------
  function renderSparks() {
    document.querySelectorAll('.spark[data-values]').forEach(el => {
      const vals = el.dataset.values.split(',').map(Number);
      if (!vals.length) return;
      const w = vals.length * 8, h = 18;
      const min = Math.min(...vals), max = Math.max(...vals);
      const range = max - min || 1;
      const d = vals.map((v, i) => {
        const x = i * (w / (vals.length - 1 || 1));
        const y = h - ((v - min) / range) * (h - 2) - 1;
        return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
      }).join(' ');
      el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '"><path d="' + d + '"/></svg>';
    });
  }

  // ---------- init ----------
  function init() {
    captureMermaidSource();
    buildTOC();
    buildProgress();
    wireEditable();
    wireTasks();
    wireCollapsible();
    wireCode();
    wireTopbar();
    wireMenus();
    wireKeys();
    renderSparks();
    setEditMode(editOn);
    // mermaid + prism may be loaded async
    if (window.mermaid) initMermaid();
    else window.addEventListener('mermaid-ready', initMermaid);
    if (window.Prism) initPrism();
    else window.addEventListener('prism-ready', initPrism);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // expose a small API for ad-hoc use
  window.AtelierPlans = { toast, exportHTML, exportMarkdown, copyForClaudeCode, copyMarkdown, resetEdits, setEditMode };
})();
