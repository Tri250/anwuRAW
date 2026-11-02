/* 透影 Crystal 改善后效果原型 · 交互逻辑（演示用） */
(function () {
  'use strict';

  /* ---------- 工具 ---------- */
  function toast(containerId, msg) {
    var el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ================= 手机 B：编辑界面 ================= */
  var editPhoto = document.getElementById('edit-photo');
  var toastEdit = 'toast-edit';

  /* 历史栈（演示 50 步撤销/重做语义） */
  var DEFAULT_FILTER = 'sepia(0.4) saturate(1.35) contrast(1.03) brightness(0.99)';
  var hist = [DEFAULT_FILTER];
  var histIdx = 0;
  var MAX_HISTORY = 50;
  var suppressPush = false;

  var btnUndoTop = document.getElementById('btn-undo');
  var btnRedoTop = document.getElementById('btn-redo');
  var actUndo = document.getElementById('act-undo');
  var actRedo = document.getElementById('act-redo');

  function refreshHistoryUi() {
    var canRedo = histIdx < hist.length - 1;
    [btnRedoTop, actRedo].forEach(function (el) {
      el.classList.toggle('disabled', !canRedo);
    });
  }

  function applyFilter(f) {
    editPhoto.style.filter = f === 'none' ? '' : f;
  }

  function pushHistory(f) {
    if (suppressPush) return;
    hist = hist.slice(0, histIdx + 1);
    hist.push(f);
    if (hist.length > MAX_HISTORY) hist.shift(); /* 上限 50 步（对齐 useEditorStore.pushHistory） */
    histIdx = hist.length - 1;
    refreshHistoryUi();
  }

  function doUndo() {
    if (histIdx <= 0) return;
    histIdx--;
    suppressPush = true;
    selectThumbByFilter(hist[histIdx]);
    applyFilter(hist[histIdx]);
    suppressPush = false;
    refreshHistoryUi();
  }

  function doRedo() {
    if (histIdx >= hist.length - 1) return;
    histIdx++;
    suppressPush = true;
    selectThumbByFilter(hist[histIdx]);
    applyFilter(hist[histIdx]);
    suppressPush = false;
    refreshHistoryUi();
  }

  btnUndoTop.addEventListener('click', doUndo);
  actUndo.addEventListener('click', doUndo);
  btnRedoTop.addEventListener('click', doRedo);
  actRedo.addEventListener('click', doRedo);

  /* 七大分类切换 */
  var catnav = document.getElementById('catnav');
  catnav.addEventListener('click', function (e) {
    var cat = e.target.closest('.cat');
    if (!cat) return;
    catnav.querySelectorAll('.cat').forEach(function (c) { c.classList.remove('on'); });
    cat.classList.add('on');
    document.querySelectorAll('#screen-edit .panel-page').forEach(function (p) {
      p.classList.toggle('show', p.dataset.page === cat.dataset.panel);
    });
  });

  /* 子标签切换（通用） */
  document.querySelectorAll('.subtabs').forEach(function (group) {
    group.addEventListener('click', function (e) {
      if (e.target.tagName !== 'SPAN') return;
      group.querySelectorAll('span').forEach(function (s) { s.classList.remove('on'); });
      e.target.classList.add('on');
    });
  });

  /* 工具格选中态 */
  document.querySelectorAll('.toolgrid').forEach(function (grid) {
    grid.addEventListener('click', function (e) {
      var tool = e.target.closest('.tool');
      if (!tool) return;
      var wasOn = tool.classList.contains('on');
      grid.querySelectorAll('.tool').forEach(function (t) { t.classList.remove('on'); });
      if (!wasOn) tool.classList.add('on');
    });
  });

  /* 滤镜缩略图 → 主预览实时滤镜（模拟 LUT） */
  var strips = document.querySelectorAll('#filter-strip, .js-filterstrip');

  function selectThumbByFilter(f) {
    var matched = null;
    strips.forEach(function (strip) {
      strip.querySelectorAll('.thumb').forEach(function (t) {
        var on = t.dataset.filter === f;
        t.classList.toggle('on', on);
        if (on) matched = t;
      });
    });
    return matched;
  }

  strips.forEach(function (strip) {
    strip.addEventListener('click', function (e) {
      var thumb = e.target.closest('.thumb');
      if (!thumb) return;
      var f = thumb.dataset.filter;
      selectThumbByFilter(f);
      applyFilter(f);
      pushHistory(f);
    });
  });

  applyFilter(DEFAULT_FILTER); /* 初始选中「日落金色」 */

  /* 强度滑杆 */
  document.querySelectorAll('#screen-edit input[type="range"]').forEach(function (r) {
    r.addEventListener('input', function () {
      var p = ((r.value - r.min) / (r.max - r.min)) * 100;
      r.style.setProperty('--p', p + '%');
      var out = r.parentElement.querySelector('output');
      if (out) out.textContent = r.value;
    });
  });

  /* AI 一键应用（写入历史栈） */
  document.getElementById('ai-apply').addEventListener('click', function () {
    selectThumbByFilter(DEFAULT_FILTER);
    applyFilter(DEFAULT_FILTER);
    pushHistory(DEFAULT_FILTER);
    var intensity = document.getElementById('intensity');
    intensity.value = 80; intensity.style.setProperty('--p', '80%');
    document.getElementById('intensity-val').textContent = '80';
    toast(toastEdit, '<span class="em">AI 推荐</span> 已应用：日落金色 · 去雾 +12 · 饱和 +8（写入 50 步历史栈）');
  });

  /* 按住看原图 / 对比（press-and-hold） */
  var holdBadge = document.getElementById('hold-badge');
  function holdStart(label) {
    return function () {
      holdBadge.textContent = label;
      holdBadge.classList.add('show');
      editPhoto.style.filter = '';
    };
  }
  function holdEnd() {
    holdBadge.classList.remove('show');
    applyFilter(hist[histIdx] === undefined ? DEFAULT_FILTER : hist[histIdx]);
  }
  [['act-orig', '原图'], ['act-cmp', '对比'], ['ovl-orig', '原图'], ['ovl-cmp', '对比']].forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (!el) return;
    el.addEventListener('pointerdown', holdStart(pair[1]));
    el.addEventListener('pointerup', holdEnd);
    el.addEventListener('pointerleave', holdEnd);
  });

  /* 重置（二次确认） */
  var confirmBox = document.getElementById('confirm-reset');
  document.getElementById('act-reset').addEventListener('click', function () {
    confirmBox.classList.add('show');
  });
  document.getElementById('confirm-cancel').addEventListener('click', function () {
    confirmBox.classList.remove('show');
  });
  document.getElementById('confirm-ok').addEventListener('click', function () {
    confirmBox.classList.remove('show');
    selectThumbByFilter('__none__');
    applyFilter('none');
    pushHistory('none');
    toast(toastEdit, '已重置全部调整（可在撤销栈恢复）');
  });

  /* 保存 → 进入导出域（FlowAccent 金 → 青） */
  function gotoExport() {
    toast(toastEdit, '<span class="em2">进入水印与导出域</span> · 强调色 金 → 青绿（data-flow 切换）');
    var phoneC = document.getElementById('phone-export');
    phoneC.classList.add('flash');
    setTimeout(function () { phoneC.classList.remove('flash'); }, 1600);
    phoneC.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  document.querySelectorAll('[data-goto-export]').forEach(function (el) {
    el.addEventListener('click', gotoExport);
  });

  /* ================= 手机 C：水印导出 ================= */
  var toastExport = 'toast-export';

  /* 信息栏与相框总开关 */
  var frameSwitch = document.getElementById('frame-switch');
  frameSwitch.addEventListener('click', function () {
    var on = frameSwitch.classList.toggle('on');
    document.getElementById('w-frame').classList.toggle('no-frame', !on);
    toast(toastExport, on ? '信息栏与相框：<span class="em2">已开启</span>' : '信息栏与相框：已关闭（纯净成片）');
  });

  /* 水印模板（6 款） */
  var tplFilters = {
    pro: '',
    minimal: 'saturate(1.06) brightness(1.02)',
    film: 'sepia(0.32) contrast(1.06)',
    landscape: 'saturate(1.22) contrast(1.04)',
    street: 'contrast(1.14) saturate(0.96)',
    bw: 'grayscale(1) contrast(1.08)'
  };
  var exportPhoto = document.getElementById('export-photo');
  document.getElementById('tpl-strip').addEventListener('click', function (e) {
    var tpl = e.target.closest('.tpl');
    if (!tpl) return;
    document.querySelectorAll('.tpl').forEach(function (t) { t.classList.remove('on'); });
    tpl.classList.add('on');
    var f = tplFilters[tpl.dataset.tpl] || '';
    exportPhoto.style.filter = f;
    toast(toastExport, '已切换模板：<span class="em2">' + tpl.querySelector('.name').textContent + '</span>');
  });

  /* 收藏 / 设为默认 / 保存模板 */
  var fav = document.getElementById('act-fav');
  fav.addEventListener('click', function () {
    var on = fav.classList.toggle('star-on');
    toast(toastExport, on ? '<span class="em">已收藏</span>「专业摄影」模板' : '已取消收藏');
  });
  var def = document.getElementById('act-default');
  def.addEventListener('click', function () {
    var on = def.classList.toggle('default-on');
    toast(toastExport, on ? '<span class="em2">已设为默认</span>（写入 app_settings）' : '已取消默认模板');
  });
  document.getElementById('act-savetpl').addEventListener('click', function () {
    toast(toastExport, '<span class="em2">模板已保存</span>（复用导出预设存储结构）');
  });

  /* 导出格式分段 */
  document.getElementById('seg-format').addEventListener('click', function (e) {
    if (e.target.tagName !== 'SPAN') return;
    this.querySelectorAll('span').forEach(function (s) { s.classList.remove('on'); });
    e.target.classList.add('on');
    toast(toastExport, '导出格式：<span class="em2">' + e.target.textContent + '</span>（GPS 元数据默认剥离）');
  });

  /* 画质三档循环 */
  var qualities = [['高质量', '100%'], ['标准', '90%'], ['兼容', '75%']];
  var qIdx = 0;
  document.getElementById('quality-pick').addEventListener('click', function () {
    qIdx = (qIdx + 1) % qualities.length;
    document.getElementById('quality-val').textContent = qualities[qIdx][1];
    this.firstChild.textContent = qualities[qIdx][0] + ' ';
  });

  /* 字体选择（P2 提示） */
  document.getElementById('font-pick').addEventListener('click', function () {
    toast(toastExport, '字体选择：系统 / 内置字体（Rust 侧枚举为 P2）');
  });

  /* 导出保存 */
  document.getElementById('w-save').addEventListener('click', function () {
    toast(toastExport, '<span class="em2">已导出</span> IMG_20261102_150842.jpg · EXIF 信息栏已合成（golden 基线通过）');
  });
})();
