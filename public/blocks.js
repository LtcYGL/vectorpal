/* 积木编程（Blockly）—— 积木树直接编译成动作序列，交给 /api/program/run 执行。
   不依赖 Blockly 代码生成器：遍历 block 树生成 steps，比生成 JS 更好控、更安全。 */
(function () {
  'use strict';

  // 精选动画（名字都在 1174 个里核对过）
  var CURATED = [
    ['anim_greeting_happy_03', '开心打招呼'],
    ['anim_greeting_goodmorning_01', '早上好'],
    ['anim_greeting_goodnight_01', '晚安'],
    ['anim_greeting_goodbye_01', '再见'],
    ['anim_feedback_iloveyou_01', '我爱你'],
    ['anim_dancebeat_eyebeat_01', '眨眼舞'],
    ['anim_dancebeat_headnod_01', '点头舞'],
    ['anim_dancebeat_cantdothat_01', '摇摆舞'],
    ['anim_dancebeat_getin_01', '跳起来'],
    ['anim_petdetection_reaction_cat_01', '像猫撒娇'],
    ['anim_petdetection_reaction_dog_01', '像狗撒欢'],
    ['anim_petting_bliss_getout_01', '被摸开心'],
    ['anim_fistbump_getin_01', '碰拳'],
    ['anim_keepaway_wingame_01', '庆祝胜利'],
    ['anim_eyepose_startled', '吓一跳'],
    ['anim_eyepose_happy', '笑眯眯'],
    ['anim_eyepose_sad', '难过'],
    ['anim_gotosleep_getin_01', '睡觉'],
    ['anim_gotosleep_getout_01', '醒来'],
    ['anim_attention_lookatdevice_01', '求关注'],
    ['anim_reacttoblock_admirecubetower_01', '欣赏积木塔'],
    ['anim_dizzy_shake_loop_01', '转晕了'],
    ['anim_blackjack_victorwin_01', '赢了'],
    ['anim_generic_look_up_01', '抬头看']
  ];

  var INTENTS = [
    ['intent_imperative_lookatme', '看看我'],
    ['intent_imperative_fistbump', '碰个拳'],
    ['intent_imperative_popawheelie', '翘轮子'],
    ['intent_imperative_rollcube', '滚方块'],
    ['intent_imperative_come', '过来'],
    ['intent_imperative_explore', '去探险'],
    ['intent_imperative_sleep', '睡觉']
  ];

  var EYES = [
    ['0.5|1', '蒂尔青'],
    ['0.33|1', '薄荷绿'],
    ['0.6|1', '天蓝'],
    ['0.78|1', '紫罗兰'],
    ['0.08|1', '暖橙'],
    ['0|1', '正红'],
    ['0.85|1', '樱花粉'],
    ['0|0', '白色']
  ];

  function animOptions() {
    var have = {};
    try { (anims || []).forEach(function (n) { have[n] = 1; }); } catch (e) {}
    var out = CURATED.filter(function (p) { return !Object.keys(have).length || have[p[0]]; })
      .map(function (p) { return [p[1], p[0]]; });
    return out.length ? out : CURATED.map(function (p) { return [p[1], p[0]]; });
  }

  var BLOCKS = [
    {
      type: 'vp_say',
      message0: '说 %1',
      args0: [{ type: 'field_input', name: 'TEXT', text: '你好！' }],
      previousStatement: null, nextStatement: null, colour: '#7C4DFF',
      tooltip: '让机器人用中文说话（本机离线合成）'
    },
    {
      type: 'vp_anim',
      message0: '播放动画 %1',
      args0: [{ type: 'field_dropdown', name: 'NAME', options: animOptions() }],
      previousStatement: null, nextStatement: null, colour: '#F06292',
      tooltip: '播放一个内置动画'
    },
    {
      type: 'vp_forward',
      message0: '前进 %1 步',
      args0: [{ type: 'field_number', name: 'N', value: 1, min: 1, max: 20, precision: 1 }],
      previousStatement: null, nextStatement: null, colour: '#4CAF50',
      tooltip: '一步约 10 厘米（会自动防跌下桌子）'
    },
    {
      type: 'vp_back',
      message0: '后退 %1 步',
      args0: [{ type: 'field_number', name: 'N', value: 1, min: 1, max: 20, precision: 1 }],
      previousStatement: null, nextStatement: null, colour: '#4CAF50'
    },
    {
      type: 'vp_turn_left',
      message0: '左转 %1 度',
      args0: [{ type: 'field_number', name: 'D', value: 90, min: 15, max: 180, precision: 15 }],
      previousStatement: null, nextStatement: null, colour: '#4CAF50'
    },
    {
      type: 'vp_turn_right',
      message0: '右转 %1 度',
      args0: [{ type: 'field_number', name: 'D', value: 90, min: 15, max: 180, precision: 15 }],
      previousStatement: null, nextStatement: null, colour: '#4CAF50'
    },
    {
      type: 'vp_head',
      message0: '脑袋 %1',
      args0: [{ type: 'field_dropdown', name: 'A', options: [['抬起来', '0.6'], ['放平', '0'], ['低下去', '-0.55']] }],
      previousStatement: null, nextStatement: null, colour: '#03A9F4'
    },
    {
      type: 'vp_lift',
      message0: '手臂 %1',
      args0: [{ type: 'field_dropdown', name: 'H', options: [['收起', '32'], ['举一半', '62'], ['举到最高', '92']] }],
      previousStatement: null, nextStatement: null, colour: '#03A9F4'
    },
    {
      type: 'vp_eye',
      message0: '眼睛变成 %1',
      args0: [{ type: 'field_dropdown', name: 'C', options: EYES.map(function (p) { return [p[1], p[0]]; }) }],
      previousStatement: null, nextStatement: null, colour: '#03A9F4'
    },
    {
      type: 'vp_intent',
      message0: '做一个表情动作 %1',
      args0: [{ type: 'field_dropdown', name: 'I', options: INTENTS.map(function (p) { return [p[1], p[0]]; }) }],
      previousStatement: null, nextStatement: null, colour: '#FF9800',
      tooltip: '和「Hey Vector」语音里说的那些动作一样'
    },
    {
      type: 'vp_photo',
      message0: '📷 拍张照片',
      previousStatement: null, nextStatement: null, colour: '#03A9F4',
      tooltip: '拍一张存进「相册」，在「看世界」页能看到'
    },
    {
      type: 'vp_when',
      message0: '当 %1 时',
      args0: [{
        type: 'field_dropdown', name: 'EVENT',
        options: [
          ['被摸头', 'touch'],
          ['被抱起来', 'pickedUp'],
          ['被放下来', 'putDown'],
          ['看到桌边', 'cliff'],
          ['放上充电仓', 'chargerOn'],
          ['离开充电仓', 'chargerOff'],
          ['按了背上的按钮', 'button']
        ]
      }],
      message1: '做 %1',
      args1: [{ type: 'input_statement', name: 'DO' }],
      colour: '#FFC107',
      tooltip: '自动反应：机器人遇到这件事时，自己把下面的积木做一遍（不用点运行也会做）'
    },
    {
      type: 'vp_wait',
      message0: '等 %1 秒',
      args0: [{ type: 'field_number', name: 'S', value: 1, min: 0.2, max: 10, precision: 0.1 }],
      previousStatement: null, nextStatement: null, colour: '#9E9E9E'
    },
    {
      type: 'vp_repeat',
      message0: '重复 %1 次',
      args0: [{ type: 'field_number', name: 'N', value: 2, min: 1, max: 10, precision: 1 }],
      message1: '做 %1',
      args1: [{ type: 'input_statement', name: 'DO' }],
      previousStatement: null, nextStatement: null, colour: '#9575CD'
    }
  ];

  var TOOLBOX = {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: '当…就…', colour: '#FFC107', contents: [{ kind: 'block', type: 'vp_when' }] },
      { kind: 'category', name: '说话', colour: '#7C4DFF', contents: [{ kind: 'block', type: 'vp_say' }] },
      { kind: 'category', name: '动起来', colour: '#F06292', contents: [
        { kind: 'block', type: 'vp_anim' },
        { kind: 'block', type: 'vp_forward' },
        { kind: 'block', type: 'vp_back' },
        { kind: 'block', type: 'vp_turn_left' },
        { kind: 'block', type: 'vp_turn_right' }
      ] },
      { kind: 'category', name: '身体', colour: '#03A9F4', contents: [
        { kind: 'block', type: 'vp_head' },
        { kind: 'block', type: 'vp_lift' },
        { kind: 'block', type: 'vp_eye' },
        { kind: 'block', type: 'vp_photo' }
      ] },
      { kind: 'category', name: '表情', colour: '#FF9800', contents: [{ kind: 'block', type: 'vp_intent' }, { kind: 'block', type: 'vp_wait' }] },
      { kind: 'category', name: '循环', colour: '#9575CD', contents: [{ kind: 'block', type: 'vp_repeat' }] }
    ]
  };

  var ws = null;
  var MAX_STEPS = 300;

  function el(id) { return document.getElementById(id); }

  // 用纯 DOM 序列化/解析，避免依赖不同 Blockly 版本的 Xml.textToDom/domToText 导出差异
  function parseXmlText(text) {
    var doc = new DOMParser().parseFromString(text, 'text/xml');
    return doc.documentElement;
  }
  function dumpXml() {
    return new XMLSerializer().serializeToString(Blockly.Xml.workspaceToDom(ws));
  }

  function ensureBlocks() {
    if (ws) { setTimeout(function () { try { Blockly.svgResize(ws); } catch (e) {} }, 60); return; }
    if (typeof Blockly === 'undefined') {
      if (el('blkState')) el('blkState').textContent = '积木引擎没加载成功';
      return;
    }
    Blockly.common.defineBlocksWithJsonArray(BLOCKS);
    ws = Blockly.inject('blocklyDiv', {
      toolbox: TOOLBOX,
      renderer: 'zelos',
      grid: { spacing: 24, length: 3, colour: '#e4e8ee', snap: true },
      zoom: { controls: true, wheel: true, startScale: 0.85, maxScale: 2, minScale: 0.4 },
      trashcan: true,
      move: { scrollbars: true, drag: true, wheel: true }
    });
    ws.addChangeListener(function (ev) {
      if (ev && ev.isUiEvent) return;
      preview();
      scheduleSave();
    });
    setTimeout(function () { try { Blockly.svgResize(ws); } catch (e) {} }, 120);
    worksReady();
  }

  // 遍历积木树 → 主程序 steps + 自动反应 rules
  function compileAll() {
    var steps = [];
    var rules = [];
    if (!ws) return { steps: steps, rules: rules };
    var tops = ws.getTopBlocks(true);
    for (var i = 0; i < tops.length; i++) {
      var t = tops[i];
      if (t.type === 'vp_when') {
        var body = [];
        var first = t.getInputTargetBlock('DO');
        if (first) walk(first, body);
        if (!body.length) continue; // 空帽子不装，免得白触发
        rules.push({
          id: 'h' + hash(String(t.getFieldValue('EVENT')) + JSON.stringify(body) + i),
          event: String(t.getFieldValue('EVENT')),
          steps: body
        });
      } else {
        walk(t, steps);
      }
    }
    return { steps: steps, rules: rules };
  }

  // 稳定的小 id：同样的积木每次装都是同一个 id，服务端不会重复堆积
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function compile() { return compileAll().steps; }

  function walk(block, out) {
    var b = block;
    while (b) {
      if (out.length > MAX_STEPS + 50) throw new Error('积木超过 ' + MAX_STEPS + ' 步了，精简一点');
      var v = function (n) { return b.getFieldValue(n); };
      switch (b.type) {
        case 'vp_say': out.push({ type: 'say', text: String(v('TEXT') || '你好！').slice(0, 200) }); break;
        case 'vp_anim': out.push({ type: 'anim', name: String(v('NAME')) }); break;
        case 'vp_forward': out.push({ type: 'forward', mm: Math.round(Number(v('N')) * 100), speed: 120 }); break;
        case 'vp_back': out.push({ type: 'back', mm: Math.round(Number(v('N')) * 100), speed: 120 }); break;
        case 'vp_turn_left': out.push({ type: 'turn', deg: -Math.abs(Number(v('D'))), speed: 100 }); break;
        case 'vp_turn_right': out.push({ type: 'turn', deg: Math.abs(Number(v('D'))), speed: 100 }); break;
        case 'vp_head': out.push({ type: 'head', angle: Number(v('A')) }); break;
        case 'vp_lift': out.push({ type: 'lift', height: Number(v('H')) }); break;
        case 'vp_eye': {
          var p = String(v('C')).split('|');
          out.push({ type: 'eye', hue: Number(p[0]), saturation: Number(p[1]), light: 0.5 });
          break;
        }
        case 'vp_intent': out.push({ type: 'intent', name: String(v('I')) }); break;
        case 'vp_photo': out.push({ type: 'photo' }); break;
        case 'vp_wait': out.push({ type: 'wait', ms: Math.round(Number(v('S')) * 1000) }); break;
        case 'vp_repeat': {
          var n = Math.min(Math.max(Math.round(Number(v('N')) || 1), 1), 10);
          var body = [];
          var first = b.getInputTargetBlock('DO');
          if (first) walk(first, body);
          for (var k = 0; k < n; k++) {
            for (var j = 0; j < body.length; j++) out.push(body[j]);
          }
          break;
        }
      }
      b = b.getNextBlock();
    }
  }

  function describe(s) {
    switch (s.type) {
      case 'say': return '说「' + s.text + '」';
      case 'anim': return '动画 ' + s.name;
      case 'forward': return '前进 ' + s.mm + 'mm';
      case 'back': return '后退 ' + s.mm + 'mm';
      case 'turn': return (s.deg >= 0 ? '右转 ' : '左转 ') + Math.abs(s.deg) + '°';
      case 'head': return '脑袋到 ' + s.angle + ' rad';
      case 'lift': return '手臂到 ' + s.height + 'mm';
      case 'eye': return '眼睛 ' + s.hue + '/' + s.saturation;
      case 'intent': return '表情 ' + s.name;
      case 'photo': return '拍张照片';
      case 'wait': return '等 ' + s.ms + 'ms';
      default: return s.type;
    }
  }

  var EVENT_LABEL = {
    touch: '被摸头', pickedUp: '被抱起来', putDown: '被放下来', cliff: '看到桌边',
    chargerOn: '放上充电仓', chargerOff: '离开充电仓', button: '按了背上的按钮'
  };

  function preview() {
    var res;
    try { res = compileAll(); } catch (e) { return; }
    var box = el('blkSteps');
    if (!box) return;
    var steps = res.steps, rules = res.rules, parts = [];
    if (rules.length) {
      parts.push('自动反应 ' + rules.length + ' 条（装好以后不用点运行，它自己会做）');
      rules.forEach(function (r) {
        parts.push('· 当' + (EVENT_LABEL[r.event] || r.event) + '时：');
        r.steps.slice(0, 12).forEach(function (s, i) { parts.push('    ' + (i + 1) + '. ' + describe(s)); });
        if (r.steps.length > 12) parts.push('    … 还有 ' + (r.steps.length - 12) + ' 步');
      });
    }
    if (steps.length) {
      parts.push((rules.length ? '\n主程序 ' : '') + steps.length + ' 步');
      steps.slice(0, 40).forEach(function (s, i) { parts.push((i + 1) + '. ' + describe(s)); });
      if (steps.length > 40) parts.push('… 还有 ' + (steps.length - 40) + ' 步');
    }
    box.textContent = parts.length ? parts.join('\n') : '把左边的积木拖进来，这里会显示程序会做什么';
  }

  function setState(t) { if (el('blkState')) el('blkState').textContent = t; }

  async function runBlocks() {
    var res;
    try { res = compileAll(); } catch (e) { toast(e.message); return; }
    var steps = res.steps, rules = res.rules;
    if (!steps.length && !rules.length) return toast('先从左边拖几块积木出来');

    // 「当…就…」整份装给机器人（工作区里没有就是全部取消）
    var installed = 0;
    if (rules.length || (await hasRules())) {
      var rr = await post('/api/rules', { items: rules });
      if (!rr || !rr.ok) { setState('自动反应保存失败：' + ((rr && rr.error) || '未知')); return; }
      installed = (rr.items || []).length;
    }

    if (!steps.length) {
      setState('已装好 ' + installed + ' 条自动反应，摸摸它试试（想取消就点「清空自动反应」）');
      return;
    }
    setState('运行中… 共 ' + steps.length + ' 步' + (installed ? '（自动反应 ' + installed + ' 条已装好）' : ''));
    var r = await post('/api/program/run', { steps: steps, loops: 1, maxMs: 300000 });
    if (r && r.ok) setState('完成，用时 ' + (r.ms / 1000).toFixed(1) + ' 秒' + (installed ? '，自动反应 ' + installed + ' 条已装好' : ''));
    else setState(r && r.aborted ? '已停下' : ('出错：' + ((r && r.error) || '未知')));
  }

  async function hasRules() {
    try {
      var u = (typeof pinUrl === 'function') ? pinUrl('/api/rules') : '/api/rules';
      var j = await (await fetch(u)).json();
      return !!(j && j.items && j.items.length);
    } catch (e) { return false; }
  }

  // 把当前主程序绑到一句口令上：「对它说这句话，它就跑这套动作」
  async function bindVoice() {
    var res;
    try { res = compileAll(); } catch (e) { toast(e.message); return; }
    if (!res.steps.length) return toast('先拼一段主程序（「当…就…」的积木不能绑口令）');
    var def = (el('blkName') && el('blkName').value.trim()) || '';
    var phrase = window.prompt('对它说哪句话时做这套动作？（2～8 个字最好，比如：跳个舞）', def);
    if (!phrase || !phrase.trim()) return;
    var r = await post('/api/voice/trigger', { op: 'add', phrase: phrase.trim(), steps: res.steps });
    if (r && r.ok) {
      setState('已绑定：说「' + phrase.trim() + '」它就跑这 ' + res.steps.length + ' 步（在「语音」页能删）');
      toast('绑好了，去对它说「Hey Vector」，再说「' + phrase.trim() + '」');
    } else {
      setState('绑定失败：' + ((r && r.error) || '未知'));
    }
  }

  async function clearRules() {
    var r = await post('/api/rules/clear', {});
    setState(r && r.ok ? '已经把自动反应都取消了' : '取消失败');
  }

  async function stopBlocks() {
    setState('正在停下…');
    var r = await post('/api/program/stop', {});
    setState(r && r.ok ? '已停下' : '停止失败');
  }

  function clearBlocks() {
    if (!ws) return;
    loadIntoWorkspace(null);
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    renderWorks();
    toast('已清空');
  }

  // ---- 作品管理：多个作品、各自命名、存在本机 ----
  var WORKS_KEY = 'vp_works', DRAFT_KEY = 'vp_draft', LAST_KEY = 'vp_lastwork';
  var curId = null, loading = false, saveTimer = null, delArm = 0;

  function escXml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function uid() { return 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
  function readWorks() {
    try { var v = JSON.parse(localStorage.getItem(WORKS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function writeWorks(list) { try { localStorage.setItem(WORKS_KEY, JSON.stringify(list)); } catch (e) { toast('本机存储写不进去了'); } }
  function findWork(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function workName() {
    var box = el('blkName');
    return (box && box.value.trim()) || '';
  }
  function renderWorks() {
    var sel = el('blkWorks');
    var list = readWorks();
    if (sel) {
      var html = '<option value="">（未保存的新作品）</option>';
      for (var i = 0; i < list.length; i++) html += '<option value="' + list[i].id + '">' + escXml(list[i].name) + '</option>';
      sel.innerHTML = html;
      sel.value = curId || '';
    }
    var st = el('blkWorkState');
    if (st) st.textContent = curId ? '已保存在本机 · 共 ' + list.length + ' 个作品' : '还没保存（改了会自动留草稿）';
  }
  function loadIntoWorkspace(xml) {
    if (!ws) return;
    loading = true;
    try {
      ws.clear();
      if (xml) Blockly.Xml.clearWorkspaceAndLoadFromXml(parseXmlText(xml), ws);
      setTimeout(function () { try { Blockly.svgResize(ws); ws.scrollCenter(); } catch (e) {} }, 60);
      preview();
    } catch (e) { toast('读取失败：' + e.message); }
    setTimeout(function () { loading = false; }, 0);
  }
  function persist() {
    if (!ws || loading) return;
    var xml = dumpXml();
    if (curId) {
      var list = readWorks(), w = findWork(list, curId);
      if (w) { w.xml = xml; w.ts = Date.now(); var n = workName(); if (n) w.name = n; writeWorks(list); }
      try { localStorage.setItem(LAST_KEY, curId); } catch (e) {}
    } else {
      try { localStorage.setItem(DRAFT_KEY, xml); } catch (e) {}
    }
    renderWorks();
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }
  function saveWork() {
    if (!ws) return;
    var name = workName() || '未命名作品';
    var list = readWorks();
    if (curId) {
      var w = findWork(list, curId);
      if (w) { w.name = name; w.xml = dumpXml(); w.ts = Date.now(); writeWorks(list); }
      try { localStorage.setItem(LAST_KEY, curId); } catch (e) {}
      toast('已保存：' + name);
    } else {
      var nw = { id: uid(), name: name, xml: dumpXml(), ts: Date.now() };
      list.push(nw); writeWorks(list); curId = nw.id;
      try { localStorage.setItem(LAST_KEY, curId); } catch (e) {}
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
      toast('已保存：' + name);
    }
    if (el('blkName')) el('blkName').value = name;
    renderWorks();
  }
  function newWork() {
    if (!ws) return;
    curId = null;
    if (el('blkName')) el('blkName').value = '';
    loadIntoWorkspace(null);
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    renderWorks();
    toast('新作品，拖积木开始吧');
  }
  function selectWork(id) {
    if (!ws) return;
    var w = findWork(readWorks(), id);
    if (!w) { curId = null; renderWorks(); return; }
    curId = w.id;
    if (el('blkName')) el('blkName').value = w.name;
    loadIntoWorkspace(w.xml);
    try { localStorage.setItem(LAST_KEY, curId); } catch (e) {}
    renderWorks();
  }
  function delWork() {
    if (!curId) { toast('当前是还没保存的新作品'); return; }
    var btn = el('blkDel');
    if (!delArm) {
      delArm = Date.now();
      if (btn) btn.textContent = '再点一次删除';
      setTimeout(function () { delArm = 0; if (btn) btn.textContent = '删除'; }, 4000);
      return;
    }
    delArm = 0;
    if (btn) btn.textContent = '删除';
    var list = readWorks().filter(function (w) { return w.id !== curId; });
    writeWorks(list);
    try { localStorage.removeItem(LAST_KEY); } catch (e) {}
    if (list.length) {
      selectWork(list[0].id);
      toast('已删除，现在打开「' + list[0].name + '」');
      return;
    }
    curId = null;
    if (el('blkName')) el('blkName').value = '';
    loadIntoWorkspace(null);
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    renderWorks();
    toast('已删除');
  }
  function worksReady() {
    var list = readWorks();
    var legacy = null;
    try { legacy = localStorage.getItem('vp_blocks'); } catch (e) {}
    if (!list.length && legacy) {
      list.push({ id: uid(), name: '我的第一个作品', xml: legacy, ts: Date.now() });
      writeWorks(list);
    }
    try { localStorage.removeItem('vp_blocks'); } catch (e) {}
    var last = null; try { last = localStorage.getItem(LAST_KEY); } catch (e) {}
    var pick = (last && findWork(list, last)) || list[0] || null;
    var draft = null; try { draft = localStorage.getItem(DRAFT_KEY); } catch (e) {}
    if (pick) {
      curId = pick.id;
      if (el('blkName')) el('blkName').value = pick.name;
      loadIntoWorkspace(pick.xml);
    } else if (draft) {
      curId = null;
      loadIntoWorkspace(draft);
    }
    renderWorks();
  }

  function saveBlocks() { saveWork(); }
  function loadBlocks() {
    var list = readWorks();
    if (!list.length) return toast('还没有保存过作品');
    selectWork(curId && findWork(list, curId) ? curId : list[0].id);
  }

// ---- 三个示例作品：点一下就有能跑的程序，孩子从改它开始学 ----
  var EXAMPLES = {
    greet: '<xml xmlns="https://developers.google.com/blockly/xml">' +
      '<block type="vp_say" x="40" y="40"><field name="TEXT">你好呀！我叫 Vector</field>' +
      '<next><block type="vp_anim"><field name="NAME">anim_greeting_happy_03</field>' +
      '<next><block type="vp_intent"><field name="I">intent_imperative_lookatme</field>' +
      '<next><block type="vp_wait"><field name="S">1</field></block></next></block></next></block></next></block></xml>',

    dance: '<xml xmlns="https://developers.google.com/blockly/xml">' +
      '<block type="vp_say" x="40" y="40"><field name="TEXT">music on！看我跳舞</field>' +
      '<next><block type="vp_repeat"><field name="N">2</field>' +
      '<statement name="DO"><block type="vp_anim"><field name="NAME">anim_dancebeat_eyebeat_01</field>' +
      '<next><block type="vp_anim"><field name="NAME">anim_dancebeat_headnod_01</field>' +
      '<next><block type="vp_anim"><field name="NAME">anim_dancebeat_cantdothat_01</field>' +
      '<next><block type="vp_wait"><field name="S">0.5</field></block></next></block></next></block></next></block>' +
      '</statement><next><block type="vp_say"><field name="TEXT">跳完啦，给我鼓掌！</field>' +
      '<next><block type="vp_intent"><field name="I">intent_imperative_fistbump</field></block></next></block></next></block></next></block></xml>',

    patrol: '<xml xmlns="https://developers.google.com/blockly/xml">' +
      '<block type="vp_say" x="40" y="40"><field name="TEXT">我去巡逻一圈，马上回来</field>' +
      '<next><block type="vp_lift"><field name="H">62</field>' +
      '<next><block type="vp_repeat"><field name="N">4</field>' +
      '<statement name="DO"><block type="vp_forward"><field name="N">1</field>' +
      '<next><block type="vp_turn_right"><field name="D">90</field>' +
      '<next><block type="vp_wait"><field name="S">0.5</field></block></next></block></next></block>' +
      '</statement><next><block type="vp_eye"><field name="C">0.33|1</field>' +
      '<next><block type="vp_say"><field name="TEXT">巡逻结束，一切正常！</field>' +
      '<next><block type="vp_lift"><field name="H">32</field></block></next></block></next></block></next></block></next></block></next></block></xml>',

    // 自动反应：装好以后不用点运行，摸它就自己动（主程序仍会先跑一遍打招呼）
    pet: '<xml xmlns="https://developers.google.com/blockly/xml">' +
      '<block type="vp_say" x="40" y="40"><field name="TEXT">我给你加了一个新本领：摸摸我的头试试</field>' +
      '<next><block type="vp_wait"><field name="S">0.5</field></block></next></block>' +
      '<block type="vp_when" x="40" y="160"><field name="EVENT">touch</field>' +
      '<statement name="DO"><block type="vp_eye"><field name="C">0.85|1</field>' +
      '<next><block type="vp_say"><field name="TEXT">好痒啊，再来再来！</field>' +
      '<next><block type="vp_anim"><field name="NAME">anim_petting_bliss_getout_01</field></block></next></block></next></block>' +
      '</statement></block></xml>'
  };

  function loadExample(name) {
    ensureBlocks();
    if (!ws) return;
    var xml = EXAMPLES[name];
    if (!xml) return toast('没有这个示例');
    try {
      ws.clear();
      Blockly.Xml.clearWorkspaceAndLoadFromXml(parseXmlText(xml), ws);
      curId = null;
      var NAME_OF = { greet: '打招呼', dance: '跳舞串烧', patrol: '小巡逻兵', pet: '摸摸我' };
      if (el('blkName')) el('blkName').value = NAME_OF[name] || name;
      try { localStorage.removeItem('vp_draft'); } catch (e) {}
      setTimeout(function () { try { Blockly.svgResize(ws); ws.scrollCenter(); } catch (e) {} }, 60);
      preview();
      renderWorks();
      toast('示例已载入，改改看，然后点「保存」');
    } catch (e) { toast('载入失败：' + e.message); }
  }

  window.ensureBlocks = ensureBlocks;
  window.runBlocks = runBlocks;
  window.stopBlocks = stopBlocks;
  window.clearBlocks = clearBlocks;
  window.saveBlocks = saveWork;
  window.loadBlocks = loadBlocks;
  window.newWork = newWork;
  window.delWork = delWork;
  window.selectWork = selectWork;
  window.loadExample = loadExample;
  window.clearRules = clearRules;
  window.bindVoice = bindVoice;

  window.addEventListener('load', function () {
    if (el('blkRun')) el('blkRun').onclick = runBlocks;
    if (el('blkStop')) el('blkStop').onclick = stopBlocks;
    if (el('blkClean')) el('blkClean').onclick = clearBlocks;
    if (el('blkSave')) el('blkSave').onclick = saveWork;
    if (el('blkNew')) el('blkNew').onclick = newWork;
    if (el('blkDel')) el('blkDel').onclick = delWork;
    if (el('blkWorks')) el('blkWorks').onchange = function () { selectWork(this.value); };
  });
})();
