import Foundation

/// 注入 WKWebView 的脚本：负责「只显示正文」的提取，以及字号/字体/配色的应用。
///
/// 为什么要自己做提取：服务端存的是**整页 HTML**（连导航、侧栏、评论区一起存），
/// 直接显示在手机上就是"字小、要横着滑"。放大只会让布局溢出，正文更看不全。
/// 所以这里在页面里挑出正文容器，剥掉壳子重新排版——字号随便调都不会超屏。
///
/// 提取策略（不追求完美，够用即可）：
///   1. 先删掉脚本/样式/导航/页眉页脚/表单/隐藏元素
///   2. 给每个候选块算分：正文文字量 × 非链接密度 + 段落数奖励，article/main 加权
///   3. 得分最高的当正文；都不像（比如整页是一张图）就退回 body 全文
///   4. 按文档顺序重排成标题/段落/引用/代码/图片
enum ReaderScript {

    /// 在页面加载完成后调用：`window.pvApply({reader:true,css:"...",textAdjust:"100%"})`
    static let source: String = #"""
    (function () {
      if (window.__pvReady) { return; }
      window.__pvReady = true;
      var PV = window.__pv = {};

      function txt(el) {
        return ((el && el.innerText) || '').replace(/\s+/g, ' ').trim();
      }
      function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
          return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
        });
      }

      var JUNK = 'script,style,link,noscript,iframe,svg,canvas,video,audio,form,button,input,select,textarea,' +
        'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="complementary"],[role="search"]';

      // 整篇剥壳：连 <head> 里的样式表一起删掉。
      // 不删的话，网页自己的 CSS 会继续给 p/div 上色——深色背景下就成了"深底深字"，看不清。
      function strip(root) {
        var list = root.querySelectorAll(JUNK);
        for (var i = 0; i < list.length; i++) {
          var n = list[i];
          if (n && n.parentNode) { n.parentNode.removeChild(n); }
        }
      }

      // 很多站的正文一开始是隐藏的，靠 JS 再显示出来。我们把脚本删了，
      // 这些内容就永远是 display:none —— innerText 拿到空串，提取结果一片空白。
      // 所以先把"隐藏"这个状态解除，再谈提取。
      function unhide(root) {
        var hidden = root.querySelectorAll('[hidden]');
        for (var i = 0; i < hidden.length; i++) { hidden[i].removeAttribute('hidden'); }
        var styled = root.querySelectorAll('[style]');
        for (var j = 0; j < styled.length; j++) {
          var css = styled[j].getAttribute('style') || '';
          if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/i.test(css)) {
            styled[j].style.display = '';
            styled[j].style.visibility = '';
            styled[j].style.opacity = '';
          }
        }
      }

      function blockScore(el) {
        var ps = el.querySelectorAll('p,li,blockquote,pre,h2,h3');
        var text = 0, count = 0;
        for (var i = 0; i < ps.length; i++) {
          var l = txt(ps[i]).length;
          if (l >= 25) { text += l; count++; }
        }
        if (text < 80) { return 0; }
        var links = el.querySelectorAll('a'), linkLen = 0;
        for (var j = 0; j < links.length; j++) { linkLen += txt(links[j]).length; }
        var density = 1 - Math.min(1, linkLen / Math.max(1, text));
        var s = text * density + count * 12;
        if (el.tagName === 'ARTICLE') { s *= 1.5; }
        else if (el.tagName === 'MAIN') { s *= 1.25; }
        if (/article|content|post|detail|entry|main|rich_media|markdown/i.test((el.className || '') + ' ' + (el.id || ''))) { s *= 1.2; }
        return s;
      }

      function pick() {
        var body = document.body;
        if (!body) { return null; }
        unhide(document);
        var cands = body.querySelectorAll('article,main,section,div,td');
        var best = null, bestScore = 0;
        for (var i = 0; i < cands.length; i++) {
          var s = blockScore(cands[i]);
          if (s > bestScore) { bestScore = s; best = cands[i]; }
        }
        if (best && bestScore >= 150) { return best; }
        return body;
      }

      function build(container) {
        var out = [];
        var h1 = document.querySelector('h1');
        var title = (h1 && txt(h1).length > 3) ? txt(h1) : (document.title || '');
        if (title) { out.push('<h1 class="pv-title">' + esc(title) + '</h1>'); }

        var seen = {};
        var nodes = container.querySelectorAll('h1,h2,h3,h4,h5,p,li,blockquote,pre,img,figcaption');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i], tag = el.tagName;

          if (tag === 'IMG') {
            var src = el.currentSrc || el.src || el.getAttribute('data-src') || el.getAttribute('data-original') || '';
            if (!src) { continue; }
            var w = el.naturalWidth || el.width || 0;
            if (w && w < 64) { continue; }                     // 图标、间距图
            if (w && w < 160 && /logo|icon|avatar|spacer|blank|qrcode/i.test(src)) { continue; }
            out.push('<img src="' + esc(src) + '" alt="">');
            continue;
          }
          if (tag === 'FIGCAPTION') {
            var cap = txt(el);
            if (cap) { out.push('<figcaption>' + esc(cap) + '</figcaption>'); }
            continue;
          }
          if (tag === 'PRE') {
            out.push('<pre>' + esc(el.innerText || '') + '</pre>');
            continue;
          }

          var t = txt(el);
          if (!t) { continue; }
          // 标题已经单独输出过，正文里的同名 h1 不要重复
          if (tag === 'H1' && t === title) { continue; }
          // iframe / 嵌套结构里重复出现的同一段文字，只留第一次
          if (seen[t]) { continue; }
          seen[t] = 1;

          if (tag === 'P' || tag === 'FIGCAPTION') {
            if (t.length < 3) { continue; }
            out.push('<p>' + esc(t) + '</p>');
          } else if (tag === 'LI') {
            if (t.length < 3) { continue; }
            out.push('<p class="pv-li">' + esc(t) + '</p>');
          } else if (tag === 'BLOCKQUOTE') {
            out.push('<blockquote>' + esc(t) + '</blockquote>');
          } else {
            var lv = Number(tag.slice(1)) || 2;
            if (lv > 4) { lv = 4; }
            if (lv < 2) { lv = 2; }
            out.push('<h' + lv + '>' + esc(t) + '</h' + lv + '>');
          }
        }
        return out.join('');
      }

      function ensureStyle(css) {
        var st = document.getElementById('pv-style');
        if (!st) {
          st = document.createElement('style');
          st.id = 'pv-style';
          (document.head || document.documentElement).appendChild(st);
        }
        st.textContent = css || '';
      }

      function fixViewport() {
        var vp = document.querySelector('meta[name="viewport"]');
        if (!vp) {
          vp = document.createElement('meta');
          vp.setAttribute('name', 'viewport');
          (document.head || document.documentElement).appendChild(vp);
        }
        vp.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
      }

      window.pvApply = function (opts) {
        opts = opts || {};

        // 第一步：要不要抽正文。抽不出来就**别动原页面**——
        // 宁可按网页原样显示（哪怕字小），也不能给用户一片空白。
        if (opts.reader && !PV.extracted && !PV.tried) {
          PV.tried = true;
          var c = pick();
          var inner = c ? build(c) : '';
          var plain = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
          PV.words = plain.length;
          if (plain.length >= 200) {
            strip(document);            // 确认要重排了，才把原样式表删掉
            document.body.innerHTML = '<div class="pv-reader">' + inner + '</div>';
            PV.extracted = true;
          }
        }

        // 第二步：按"最终到底用的是哪种模式"上样式。
        // 提取失败时要退回原文模式的 CSS，否则会把原页面刷成阅读器的底色。
        var useReader = !!PV.extracted;
        ensureStyle(useReader ? (opts.css || '') : (opts.fallbackCss || ''));

        if (useReader) {
          fixViewport();
          document.documentElement.setAttribute('data-pv-mode', 'reader');
        } else {
          document.documentElement.setAttribute('data-pv-mode', 'original');
        }

        if (opts.textAdjust) {
          document.documentElement.style.webkitTextSizeAdjust = opts.textAdjust;
          if (document.body) { document.body.style.webkitTextSizeAdjust = opts.textAdjust; }
        }
        window.scrollTo(0, 0);
        return useReader ? (PV.words || 0) : -1;
      };
    })();
    """#
}
