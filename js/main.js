console.log("\n %c HeoMusic 开源静态音乐播放器 %c https://github.com/zhheo/HeoMusic \n", "color: #fadfa3; background: #030307; padding:5px 0;", "background: #fadfa3; padding:5px 0;")
var local = false;
var isScrolling = false; // 添加全局变量 isScrolling，默认为 false
var scrollTimer = null; // 添加定时器变量
var animationFrameId = null; // 添加变量用于跟踪动画帧ID

if (typeof userId === 'undefined') {
  var userId = "8152976493"; // 替换为实际的默认值
}
if (typeof userServer === 'undefined') {
  var userServer = "netease"; // 替换为实际的默认值
}
if (typeof userType === 'undefined') {
  var userType = "playlist"; // 替换为实际的默认值
}

if (typeof remoteMusic !== 'undefined' && remoteMusic) {
  fetch(remoteMusic)
    .then(response => response.json())
    .then(data => {
      if (Array.isArray(data)) {
        localMusic = data;
      }
      loadMusicScript();
    })
    .catch(error => {
      console.error('Error fetching remoteMusic:', error);
      loadMusicScript();
    });
} else {
  loadMusicScript();
}

function loadMusicScript() {
  if (typeof localMusic === 'undefined' || !Array.isArray(localMusic) || localMusic.length === 0) {
    // 如果 localMusic 为空数组或未定义，加载 Meting2.min.js
    var script = document.createElement('script');
    script.src = './js/Meting.js';
    document.body.appendChild(script);
  } else {
    // 否则加载 localEngine.js
    var script = document.createElement('script');
    script.src = './js/localEngine.js';
    document.body.appendChild(script);
    local = true;
  }
}

var volume = 0.8;
const enhanceState = {
  inited: false,
  lyricOffset: 0,
  showRemaining: false,
  demoMode: false,
  fluid: { raf: null, canvasCtx: null, audioCtx: null, source: null, analyzer: null, dataArray: null, paused: false }
};

// 获取地址栏参数
// 创建URLSearchParams对象并传入URL中的查询字符串
const params = new URLSearchParams(window.location.search);

function escapeHTML(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, function (char) {
    return ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char];
  });
}

var heo = {
  lyricRuntime: {
    cache: new Map(),
    currentDetail: [],
    activeWordIndex: -1,
    rafId: null,
    boundPlayer: null
  },
  getCurrentLyricText: function () {
    const currentLine = document.querySelector('.aplayer-lrc-current');
    if (!currentLine) return '';
    return currentLine.getAttribute('data-primary') || currentLine.querySelector('.aplayer-lrc-main')?.textContent || currentLine.textContent || '';
  },
  appendQueryParams: function (url, extraParams) {
    if (!url || typeof url !== 'string') return url;
    try {
      const target = new URL(url, window.location.href);
      Object.keys(extraParams || {}).forEach((key) => {
        const value = extraParams[key];
        if (value !== undefined && value !== null && value !== '') {
          target.searchParams.set(key, value);
        }
      });
      return target.toString();
    } catch (error) {
      return url;
    }
  },
  isStructuredLyricApi: function (url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const target = new URL(url, window.location.href);
      return target.searchParams.get('type') === 'lrc' || /\/meting\/?/i.test(target.pathname);
    } catch (error) {
      return false;
    }
  },
  createLyricRequestUrls: function (rawUrl) {
    if (!this.isStructuredLyricApi(rawUrl)) {
      return {
        enhanced: rawUrl,
        secondary: ''
      };
    }
    return {
      enhanced: this.appendQueryParams(rawUrl, { format: 'elrc', lrc_normalize: 'true' }),
      secondary: this.appendQueryParams(rawUrl, { format: 'lrc', trans: 'true', roma: 'true', lrc_normalize: 'true' })
    };
  },
  parseTimestamp: function (value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value && value !== 0) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
    const pure = text.replace(/[<>[\]]/g, '');
    const parts = pure.split(':').map(Number);
    if (parts.some((item) => Number.isNaN(item))) return null;
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return null;
  },
  parseStandardLrc: function (content) {
    if (!content) return [];
    const rows = [];
    const normalized = String(content).replace(/\r/g, '').replace(/([^\]^\n])\[/g, '$1\n[');
    normalized.split('\n').forEach((line) => {
      const timeTags = line.match(/\[(\d{2}):(\d{2})(\.(\d{2,3}))?]/g);
      if (!timeTags) return;
      const text = line.replace(/\[(\d{2}):(\d{2})(\.(\d{2,3}))?]/g, '').trim();
      timeTags.forEach((tag) => {
        const time = this.parseTimestamp(tag);
        if (time !== null) {
          rows.push([time, text]);
        }
      });
    });
    return rows.sort((a, b) => a[0] - b[0]);
  },
  parseEnhancedLrc: function (content) {
    const baseLines = this.parseStandardLrc(content);
    if (!baseLines.length) {
      return [{
        time: 0,
        text: '暂无歌词',
        secondary: [],
        words: []
      }];
    }

    const rawLines = String(content).replace(/\r/g, '').split('\n');
    const detailByTime = new Map();

    rawLines.forEach((rawLine) => {
      const timeTags = rawLine.match(/\[(\d{2}):(\d{2})(\.(\d{2,3}))?]/g);
      if (!timeTags) return;

      const lineText = rawLine.replace(/\[(\d{2}):(\d{2})(\.(\d{2,3}))?]/g, '').trim();
      const wordMatches = [...rawLine.matchAll(/<(\d{2}):(\d{2})(\.(\d{2,3}))?>([^<\n]*)/g)];
      const words = [];
      wordMatches.forEach((match, index) => {
        const time = this.parseTimestamp(`${match[1]}:${match[2]}${match[3] || ''}`);
        const text = (match[5] || '').replace(/\s+/g, ' ');
        if (time === null || !text) return;
        words.push({
          text,
          start: time,
          end: null,
          index
        });
      });

      const mainText = lineText.replace(/<(\d{2}):(\d{2})(\.(\d{2,3}))?>/g, '').trim();
      timeTags.forEach((tag) => {
        const time = this.parseTimestamp(tag);
        if (time === null) return;
        detailByTime.set(Number(time.toFixed(3)), {
          text: mainText,
          words
        });
      });
    });

    return baseLines.map((entry, index) => {
      const time = entry[0];
      const nextLine = baseLines[index + 1];
      const key = Number(time.toFixed(3));
      const detail = detailByTime.get(key);
      const words = (detail?.words || []).map((word, wordIndex, list) => ({
        text: word.text,
        start: word.start,
        end: list[wordIndex + 1]
          ? Math.max(word.start, list[wordIndex + 1].start)
          : (nextLine?.[0] ?? Math.max(time + 4, word.start + 0.4)),
        index: word.index
      }));

      return {
        time,
        text: detail?.text || entry[1],
        secondary: [],
        words
      };
    });
  },
  shouldIgnoreSecondaryLine: function (text) {
    if (!text) return true;
    const normalized = String(text).trim();
    if (!normalized) return true;
    return /^\[(ti|ar|al|by|offset|kana|language|length):/i.test(normalized);
  },
  findNearestMainLineIndex: function (mainLines, time, threshold) {
    if (!mainLines.length) return -1;
    let nearestIndex = -1;
    let nearestDelta = Number.POSITIVE_INFINITY;

    for (let i = 0; i < mainLines.length; i++) {
      const delta = Math.abs(mainLines[i].time - time);
      if (delta < nearestDelta) {
        nearestDelta = delta;
        nearestIndex = i;
      }
      if (mainLines[i].time > time && delta > nearestDelta) {
        break;
      }
    }

    return nearestDelta <= threshold ? nearestIndex : -1;
  },
  mergeSecondaryLyrics: function (mainLines, secondaryContent) {
    if (!secondaryContent || !mainLines.length) return mainLines;
    const mergedLines = mainLines.map((line) => ({
      ...line,
      secondary: Array.isArray(line.secondary) ? [...line.secondary] : []
    }));
    const secondaryLines = this.parseStandardLrc(secondaryContent);

    secondaryLines.forEach(([time, text]) => {
      if (this.shouldIgnoreSecondaryLine(text)) return;
      const mainIndex = this.findNearestMainLineIndex(mergedLines, time, 0.45);
      if (mainIndex === -1) return;
      const target = mergedLines[mainIndex];
      if (text === target.text) return;
      if (!target.secondary.includes(text)) {
        target.secondary.push(text);
      }
    });

    return mergedLines;
  },
  renderLyricLine: function (line, index) {
    const mainContent = line.words.length
      ? line.words.map((word, wordIndex) => `<span class="aplayer-lrc-word" data-word-index="${wordIndex}" style="--word-progress:0;"><span class="aplayer-lrc-word-text">${escapeHTML(word.text)}</span></span>`).join('')
      : escapeHTML(line.text || '');
    const secondaryContent = line.secondary.map((text) => `<span class="aplayer-lrc-subline">${escapeHTML(text)}</span>`).join('');
    return `<p class="${index === 0 ? 'aplayer-lrc-current' : ''}" data-line-index="${index}" data-primary="${escapeHTML(line.text || '')}">
      <span class="aplayer-lrc-main">${mainContent}</span>
      ${secondaryContent}
    </p>`;
  },
  renderLyrics: function (container, lines) {
    container.innerHTML = lines.map((line, index) => this.renderLyricLine(line, index)).join('');
  },
  fetchLyricBundle: async function (url) {
    const cached = this.lyricRuntime.cache.get(url);
    if (cached) return cached;

    const task = (async () => {
      const requestUrls = this.createLyricRequestUrls(url);
      const [enhancedRes, secondaryRes] = await Promise.allSettled([
        fetch(requestUrls.enhanced).then((res) => {
          if (!res.ok) throw new Error(`enhanced lyric request failed: ${res.status}`);
          return res.text();
        }),
        requestUrls.secondary
          ? fetch(requestUrls.secondary).then((res) => {
            if (!res.ok) throw new Error(`secondary lyric request failed: ${res.status}`);
            return res.text();
          })
          : Promise.resolve('')
      ]);

      const enhancedText = enhancedRes.status === 'fulfilled' ? enhancedRes.value : '';
      const secondaryText = secondaryRes.status === 'fulfilled' ? secondaryRes.value : '';
      const mainLines = this.parseEnhancedLrc(enhancedText);
      const merged = this.mergeSecondaryLyrics(mainLines, secondaryText);

      return {
        lines: merged,
        current: merged.map((line) => [line.time, line.text || ''])
      };
    })().catch(() => ({
      lines: [{
        time: 0,
        text: '暂无歌词',
        secondary: [],
        words: []
      }],
      current: [[0, '暂无歌词']]
    }));

    this.lyricRuntime.cache.set(url, task);
    return task;
  },
  stopLyricTicker: function () {
    if (this.lyricRuntime.rafId !== null) {
      cancelAnimationFrame(this.lyricRuntime.rafId);
      this.lyricRuntime.rafId = null;
    }
  },
  startLyricTicker: function (player) {
    if (!player?.lrc || player.paused) return;
    this.lyricRuntime.boundPlayer = player;
    this.stopLyricTicker();
    const tick = () => {
      if (!this.lyricRuntime.boundPlayer || this.lyricRuntime.boundPlayer !== player || player.paused) {
        this.lyricRuntime.rafId = null;
        return;
      }
      player.lrc.update(player.audio.currentTime);
      this.lyricRuntime.rafId = requestAnimationFrame(tick);
    };
    this.lyricRuntime.rafId = requestAnimationFrame(tick);
  },
  enhanceLyrics: function (player) {
    if (!player || !player.lrc || player.lrc.__heoEnhanced) return;

    const original = {
      show: player.lrc.show.bind(player.lrc),
      hide: player.lrc.hide.bind(player.lrc),
      toggle: player.lrc.toggle.bind(player.lrc)
    };
    const lyricModule = player.lrc;
    lyricModule.__heoEnhanced = true;
    lyricModule.__heoOriginal = original;
    lyricModule.parsedDetails = [];

    lyricModule.switch = async function (songIndex) {
      const audio = this.player.list.audios[songIndex];
      const lrcUrl = audio?.lrc;

      this.index = 0;
      heo.lyricRuntime.activeWordIndex = -1;
      heo.stopLyricTicker();

      if (!lrcUrl) {
        const fallback = [{ time: 0, text: '暂无歌词', secondary: [], words: [] }];
        this.parsed[songIndex] = [[0, '暂无歌词']];
        this.parsedDetails[songIndex] = fallback;
        this.current = this.parsed[songIndex];
        heo.lyricRuntime.currentDetail = fallback;
        heo.renderLyrics(this.container, fallback);
        this.update(0);
        return;
      }

      this.container.innerHTML = '<p class="aplayer-lrc-current" data-line-index="0" data-primary="歌词加载中"><span class="aplayer-lrc-main">歌词加载中</span></p>';

      const bundle = await heo.fetchLyricBundle(lrcUrl);
      if (songIndex !== this.player.list.index) return;

      this.parsed[songIndex] = bundle.current;
      this.parsedDetails[songIndex] = bundle.lines;
      this.current = bundle.current;
      heo.lyricRuntime.currentDetail = bundle.lines;
      heo.renderLyrics(this.container, bundle.lines);
      this.update(0);
      heo.startLyricTicker(this.player);
      pageEnhancer.checkNoScrollLyric();
    };

    lyricModule.update = function () {
      const currentTime = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : this.player.audio.currentTime;
      if (!this.current.length) return;

      let activeIndex = 0;
      for (let i = 0; i < this.current.length; i++) {
        if (currentTime >= this.current[i][0] && (!this.current[i + 1] || currentTime < this.current[i + 1][0])) {
          activeIndex = i;
          break;
        }
      }

      if (this.index !== activeIndex) {
        const prev = this.container.querySelector('.aplayer-lrc-current');
        const next = this.container.querySelector(`p[data-line-index="${activeIndex}"]`);
        prev && prev.classList.remove('aplayer-lrc-current');
        next && next.classList.add('aplayer-lrc-current');
        this.container.querySelectorAll('.aplayer-lrc-word-active').forEach((wordEl) => wordEl.classList.remove('aplayer-lrc-word-active'));
        this.index = activeIndex;
        heo.lyricRuntime.activeWordIndex = -1;
        heo.scrollLyric();
      }

      const lineDetail = heo.lyricRuntime.currentDetail[activeIndex];
      if (!lineDetail?.words?.length) return;

      const currentLineEl = this.container.querySelector(`p[data-line-index="${activeIndex}"]`);
      if (!currentLineEl) return;
      let activeWordIndex = -1;
      currentLineEl.querySelectorAll('.aplayer-lrc-word').forEach((wordEl, index) => {
        const word = lineDetail.words[index];
        if (!word) return;
        let progress = 0;
        if (currentTime >= word.end) {
          progress = 1;
        } else if (currentTime >= word.start && currentTime < word.end) {
          const duration = Math.max(word.end - word.start, 0.01);
          progress = Math.min(1, Math.max(0, (currentTime - word.start) / duration));
          activeWordIndex = index;
        }
        wordEl.style.setProperty('--word-progress', progress.toFixed(3));
        wordEl.classList.toggle('aplayer-lrc-word-active', progress > 0);
      });
      heo.lyricRuntime.activeWordIndex = activeWordIndex;
    };

    lyricModule.remove = function (index) {
      this.parsed.splice(index, 1);
      this.parsedDetails.splice(index, 1);
    };

    lyricModule.clear = function () {
      this.parsed = [];
      this.parsedDetails = [];
      this.current = [];
      heo.lyricRuntime.currentDetail = [];
      this.container.innerHTML = '';
    };

    lyricModule.show = original.show;
    lyricModule.hide = original.hide;
    lyricModule.toggle = original.toggle;

    lyricModule.switch(player.list.index);
  },
  // 处理滚动和触摸事件的通用方法
  handleScrollOrTouch: function(event, isTouchEvent) {
    // 检查事件的目标元素是否在相关区域内部
    let targetElement = event.target;
    let isInTargetArea = false;
    
    // 向上遍历DOM树，检查是否在目标区域内
    while (targetElement && targetElement !== document) {
      if (targetElement.classList) {
        if (isTouchEvent) {
          // 触摸事件检查 aplayer-body 或 aplayer-lrc
          if (targetElement.classList.contains('aplayer-body') || 
              targetElement.classList.contains('aplayer-lrc')) {
            isInTargetArea = true;
            break;
          }
        } else {
          // 鼠标滚轮事件只检查 aplayer-body
          if (targetElement.classList.contains('aplayer-body')) {
            isInTargetArea = true;
            break;
          }
        }
      }
      targetElement = targetElement.parentNode;
    }
    
    // 只有当在目标区域内时才改变 isScrolling
    if (isInTargetArea) {
      // 取消任何正在进行的动画
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      
      // 设置isScrolling为true
      isScrolling = true;
      
      // 清除之前的定时器
      if(scrollTimer !== null) {
        clearTimeout(scrollTimer);
      }
      
      // 设置新的定时器，恢复isScrolling为false
      // 触摸事件给予更长的时间
      const timeoutDuration = isTouchEvent ? 4500 : 4000;
      scrollTimer = setTimeout(function() {
        isScrolling = false;
        heo.scrollLyric();
      }, timeoutDuration);
    }
  },
  
  // 初始化滚动和触摸事件
  initScrollEvents: function() {
    // 监听鼠标滚轮事件
    document.addEventListener('wheel', (event) => {
      this.handleScrollOrTouch(event, false);
    }, { passive: true });
    
    // 监听触摸滑动事件
    document.addEventListener('touchmove', (event) => {
      this.handleScrollOrTouch(event, true);
    }, { passive: true });
  },

  scrollLyric: function () {
    // 当 isScrolling 为 true 时，跳过执行
    if (isScrolling) {
      return;
    }
    
    const lrcContent = document.querySelector('.aplayer-lrc');
    const currentLyric = document.querySelector('.aplayer-lrc-current');

    if (lrcContent && currentLyric) {
      let startScrollTop = lrcContent.scrollTop;
      let targetScrollTop = currentLyric.offsetTop - (window.innerHeight - 150) * 0.3; // 目标位置在30%的dvh位置
      let distance = targetScrollTop - startScrollTop;
      let duration = 600; // 缩短动画时间以提高流畅度
      let startTime = null;

      function easeOutQuad(t) {
        return t * (2 - t);
      }

      function animateScroll(currentTime) {
        // 如果用户正在手动滚动，停止动画
        if (isScrolling) {
          animationFrameId = null;
          return;
        }
        
        if (startTime === null) startTime = currentTime;
        let timeElapsed = currentTime - startTime;
        let progress = Math.min(timeElapsed / duration, 1);
        let easeProgress = window.innerWidth < 768 ? progress : easeOutQuad(progress);
        lrcContent.scrollTop = startScrollTop + (distance * easeProgress);
        
        if (timeElapsed < duration) {
          animationFrameId = requestAnimationFrame(animateScroll);
        } else {
          animationFrameId = null;
        }
      }

      // 取消任何正在进行的动画
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      
      animationFrameId = requestAnimationFrame(animateScroll);
    }
  },

  getCustomPlayList: function () {
    const heoMusicPage = document.getElementById("heoMusic-page");
    const playlistType = params.get("type") || "playlist";

    if (params.get("id") && params.get("server")) {
      console.log("获取到自定义内容")
      var id = params.get("id")
      var server = params.get("server")
      heoMusicPage.innerHTML = `<meting-js id="${id}" server="${server}" type="${playlistType}" mutex="true" preload="auto" order="random"></meting-js>`;
    } else {
      console.log("无自定义内容")
      heoMusicPage.innerHTML = `<meting-js id="${userId}" server="${userServer}" type="${userType}" mutex="true" preload="auto" order="random"></meting-js>`;
    }
  },

  bindEvents: function () {
    var e = this;
    // 添加歌词点击件
    if (this.lrc) {
      this.template.lrc.addEventListener('click', function (event) {
        // 确保点击的是歌词 p 元素
        var target = event.target;
        if (target.tagName.toLowerCase() === 'p') {
          // 获取所有歌词元素
          var lyrics = e.template.lrc.getElementsByTagName('p');
          // 找到被点击歌词的索引
          for (var i = 0; i < lyrics.length; i++) {
            if (lyrics[i] === target) {
              // 获取对应时间并跳转
              if (e.lrc.current[i]) {
                var time = e.lrc.current[i][0];
                e.seek(time);
                if (e.paused) {
                  e.play();
                }
              }
              break;
            }
          }
        }
      });
    }
  },
  // 添加新方法处理歌词点击
  addLyricClickEvent: function () {
    const lrcContent = document.querySelector('.aplayer-lrc-contents');

    if (lrcContent && !lrcContent.dataset.heoLyricBound) {
      lrcContent.dataset.heoLyricBound = 'true';
      lrcContent.addEventListener('click', function (event) {
        const lineEl = event.target.closest('p[data-line-index]');
        if (lineEl) {
          const lyrics = lrcContent.getElementsByTagName('p');
          for (let i = 0; i < lyrics.length; i++) {
            if (lyrics[i] === lineEl) {
              // 获取当前播放器实例
              const player = ap;
              // 使用播放器内部的歌词数据
              if (player.lrc.current[i]) {
                const time = player.lrc.current[i][0];
                player.seek(time);
                // 点击歌词后不再等待4s，立即跳转
                isScrolling = false;
                clearTimeout(scrollTimer);
                // 如果当前是暂停状态,则恢复播放
                if (player.paused) {
                  player.play();
                }
              }
              event.stopPropagation(); // 阻止事件冒泡
              break;
            }
          }
        }
      });
    }
  },
  setMediaMetadata: function (aplayerObj, isSongPlaying) {
    const audio = aplayerObj.list.audios[aplayerObj.list.index]
    const coverUrl = audio.cover || './img/icon.webp';
    const currentLrcContent = this.getCurrentLyricText();
    let songName, songArtist;

    if ('mediaSession' in navigator) {
      if (isSongPlaying && currentLrcContent) {
        songName = currentLrcContent;
        songArtist = `${audio.artist} / ${audio.name}`;
      } else {
        songName = audio.name;
        songArtist = audio.artist;
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title: songName,
        artist: songArtist,
        album: audio.album,
        artwork: [
          { src: coverUrl, sizes: '96x96', type: 'image/jpeg' },
          { src: coverUrl, sizes: '128x128', type: 'image/jpeg' },
          { src: coverUrl, sizes: '192x192', type: 'image/jpeg' },
          { src: coverUrl, sizes: '256x256', type: 'image/jpeg' },
          { src: coverUrl, sizes: '384x384', type: 'image/jpeg' },
          { src: coverUrl, sizes: '512x512', type: 'image/jpeg' }
        ]
      });
    } else {
      console.log('当前浏览器不支持 Media Session API');
      document.title = `${audio.name} - ${audio.artist}`;
    }
  },
  // 响应 MediaSession 标准媒体交互
  setupMediaSessionHandlers: function (aplayer) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        aplayer.play();
      });

      navigator.mediaSession.setActionHandler('pause', () => {
        aplayer.pause();
      });

      // 移除快进快退按钮
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);

      // 设置上一曲下一曲按钮
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        aplayer.skipBack();
      });

      navigator.mediaSession.setActionHandler('nexttrack', () => {
        aplayer.skipForward();
      });

      // 响应进度条拖动
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.fastSeek && 'fastSeek' in aplayer.audio) {
          aplayer.audio.fastSeek(details.seekTime);
        } else {
          aplayer.audio.currentTime = details.seekTime;
        }
      });

      // 更新 Media Session 元数据
      aplayer.on('loadeddata', () => {
        heo.setMediaMetadata(aplayer, false);
      });

      // 更新播放状态
      aplayer.on('play', () => {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
          heo.setMediaMetadata(aplayer, true);
        }
        heo.startLyricTicker(aplayer);
      });

      aplayer.on('pause', () => {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
          heo.setMediaMetadata(aplayer, false);
        }
        heo.stopLyricTicker();
      });

      // 监听时间更新事件
      aplayer.on('timeupdate', () => {
        heo.setMediaMetadata(aplayer, true);
      });
    }
  },
  updateThemeColorWithImage(img) {
    if (local) {
      const updateThemeColor = (colorThief) => {
        const dominantColor = colorThief.getColor(img);
        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) {
          // 叠加rgba(0,0,0,0.4)的效果
          const r = Math.round(dominantColor[0] * 0.6); // 原色 * 0.6 实现叠加黑色透明度0.4的效果
          const g = Math.round(dominantColor[1] * 0.6);
          const b = Math.round(dominantColor[2] * 0.6);
          metaThemeColor.setAttribute('content', `rgb(${r},${g},${b})`);
        }
      };

      if (typeof ColorThief === 'undefined') {
        const script = document.createElement('script');
        script.src = './js/color-thief.min.js';
        script.onload = () => updateThemeColor(new ColorThief());
        document.body.appendChild(script);
      } else {
        updateThemeColor(new ColorThief());
      }
    }

  },
  
  // 新增方法：将歌词滚动到顶部
  scrollLyricToTop: function() {
    const lrcContent = document.querySelector('.aplayer-lrc');
    if (lrcContent) {
      // 使用平滑滚动效果，但不过于缓慢
      lrcContent.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    }
  },
  
  // 初始化所有事件
  init: function() {
    this.getCustomPlayList();
    this.initScrollEvents();
  }
}

const pageEnhancer = {
  ensureFluidAudioGraph() {
    if (enhanceState.fluid.analyzer || !window.ap || !ap.audio) return;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const audioContext = new AudioContextCtor();
      const src = audioContext.createMediaElementSource(ap.audio);
      const analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 128;
      src.connect(analyzer);
      analyzer.connect(audioContext.destination);
      enhanceState.fluid.audioCtx = audioContext;
      enhanceState.fluid.source = src;
      enhanceState.fluid.analyzer = analyzer;
      enhanceState.fluid.dataArray = new Uint8Array(analyzer.frequencyBinCount);
    } catch (e) {
      console.warn('Fluid background audio graph init failed:', e);
    }
  },
  resumeFluidAudioGraph() {
    this.ensureFluidAudioGraph();
    const ctx = enhanceState.fluid.audioCtx;
    if (!ctx || typeof ctx.resume !== 'function' || ctx.state === 'running') return;
    ctx.resume().catch((error) => {
      console.warn('Fluid background audio graph resume failed:', error);
    });
  },
  initOnce() {
    if (enhanceState.inited || !window.ap || !ap.audio) return;
    enhanceState.inited = true;
    this.bindPanel();
    this.bindPlayerEvents();
    this.bindLyricContextMenu();
    this.bindProgressPreview();
    this.initIdleDetector();
    this.initFluidBackground();
    this.refreshByAudio();
  },
  bindPanel() {
    const panel = document.getElementById('settings-panel');
    document.getElementById('toggle-settings').onclick = () => panel.classList.toggle('show');
    document.getElementById('bg-mode').onchange = (e) => this.setBgMode(e.target.value);
    document.getElementById('bg-blur').oninput = (e) => document.body.style.setProperty('--bg-blur', `${e.target.value}px`);
    document.getElementById('bg-dim').oninput = (e) => document.body.style.setProperty('--bg-dim', `${e.target.value / 100}`);
    document.getElementById('bg-opacity').oninput = (e) => document.body.style.setProperty('--bg-opacity', `${e.target.value}`);
    document.getElementById('lyric-offset').oninput = (e) => { enhanceState.lyricOffset = Number(e.target.value); };
    document.getElementById('demo-mode').onchange = (e) => { enhanceState.demoMode = e.target.checked; };
    document.getElementById('toggle-fullscreen').onclick = () => this.toggleFullscreen();
    document.getElementById('toggle-time-mode').onclick = () => { enhanceState.showRemaining = !enhanceState.showRemaining; };
  },
  bindPlayerEvents() {
    ['loadeddata', 'listswitch'].forEach((eventName) => ap.on(eventName, () => this.refreshByAudio()));
    ap.on('play', () => {
      enhanceState.fluid.paused = false;
      this.resumeFluidAudioGraph();
      heo.startLyricTicker(ap);
    });
    ap.on('pause', () => {
      enhanceState.fluid.paused = true;
      heo.stopLyricTicker();
    });
    ap.on('timeupdate', () => this.syncTimeMode());
  },
  setBgMode(mode) {
    const bg = document.getElementById('dynamic-bg');
    bg.className = '';
    bg.classList.add(`bg-${mode}`);
  },
  refreshByAudio() {
    const audio = ap.list.audios[ap.list.index];
    if (!audio) return;
    document.body.style.setProperty('--cover-url', `url('${audio.cover || './img/cover.webp'}')`);
    this.extractThemeFromCover(audio.cover || './img/cover.webp');
    this.fixLongTitle();
    this.checkNoScrollLyric();
  },
  extractThemeFromCover(cover) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        if (typeof ColorThief === 'undefined') {
          document.body.style.setProperty('--accent', '#8f939a');
          return;
        }
        const thief = new ColorThief();
        const [r, g, b] = thief.getColor(img);
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        const accent = saturation < 0.15 ? '#8f939a' : `rgb(${r},${g},${b})`;
        document.body.style.setProperty('--accent', accent);
      } catch (e) {
        document.body.style.setProperty('--accent', '#8f939a');
      }
    };
    img.src = cover;
  },
  fixLongTitle() {
    const titleEl = document.querySelector('.aplayer-title');
    if (!titleEl) return;
    const len = (titleEl.textContent || '').length;
    titleEl.style.fontSize = len > 16 ? '1.2rem' : '1.6rem';
  },
  bindLyricContextMenu() {
    const lrcBox = document.querySelector('.aplayer-lrc-contents');
    if (!lrcBox) return;
    lrcBox.addEventListener('contextmenu', async (e) => {
      const line = e.target.closest('p');
      if (!line) return;
      e.preventDefault();
      await navigator.clipboard.writeText(line.textContent.trim());
    });
  },
  bindProgressPreview() {
    const wrap = document.querySelector('.aplayer-bar-wrap');
    const preview = document.getElementById('hover-lyric-preview');
    if (!wrap) return;
    wrap.addEventListener('mousemove', (e) => {
      if (!ap.lrc?.current?.length) return;
      const rect = wrap.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const sec = ratio * ap.audio.duration;
      let currentLine = '';
      let index = 0;
      ap.lrc.current.forEach((item, i) => { if (item[0] <= sec + enhanceState.lyricOffset / 1000) { currentLine = item[1]; index = i + 1; } });
      preview.innerHTML = `${this.formatTime(sec)} ｜ 第${index}句<br>${currentLine || '纯音乐/无可预览歌词'}`;
      preview.style.left = `${e.clientX + 10}px`;
      preview.style.top = `${e.clientY - 48}px`;
      preview.classList.remove('hidden');
    });
    wrap.addEventListener('mouseleave', () => preview.classList.add('hidden'));
  },
  checkNoScrollLyric() {
    const hint = document.getElementById('lyric-scroll-hint');
    const lines = document.querySelectorAll('.aplayer-lrc p');
    const noScroll = lines.length <= 1 || [...lines].every(el => (el.textContent || '').includes('纯音乐'));
    hint.classList.toggle('hidden', !noScroll);
  },
  syncTimeMode() {
    const timeEl = document.querySelector('.aplayer-dtime');
    if (!timeEl || !enhanceState.showRemaining) return;
    const remain = Math.max(0, (ap.audio.duration || 0) - (ap.audio.currentTime || 0));
    timeEl.textContent = `-${this.formatTime(remain)}`;
  },
  formatTime(seconds) {
    const s = Math.floor(seconds || 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  },
  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  },
  initIdleDetector() {
    let timer = null;
    const wake = () => {
      document.body.classList.remove('idle');
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (enhanceState.demoMode) document.body.classList.add('idle');
      }, 2400);
    };
    document.addEventListener('mousemove', wake);
    wake();
  },
  initFluidBackground() {
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    document.getElementById('dynamic-bg').appendChild(canvas);
    const ctx = canvas.getContext('2d');
    enhanceState.fluid.canvasCtx = ctx;
    const draw = () => {
      const { analyzer, dataArray } = enhanceState.fluid;
      let energy = 22;
      if (analyzer && dataArray) {
        analyzer.getByteFrequencyData(dataArray);
        energy = dataArray.reduce((sum, n) => sum + n, 0) / dataArray.length / 6;
      }
      if (!enhanceState.fluid.paused) {
        const t = Date.now() / 1000;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < 4; i++) {
          const x = (Math.sin(t * (0.2 + i * 0.1)) * 0.3 + 0.5) * canvas.width;
          const y = (Math.cos(t * (0.18 + i * 0.1)) * 0.3 + 0.5) * canvas.height;
          const r = 180 + i * 90 + energy * 2;
          ctx.fillStyle = `hsla(${(t * 30 + i * 60) % 360}, 75%, 60%, 0.12)`;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
      }
      enhanceState.fluid.raf = requestAnimationFrame(draw);
    };
    draw();
    window.addEventListener('resize', () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; });
    setInterval(() => {
      const clock = document.getElementById('fullscreen-clock');
      const inFull = !!document.fullscreenElement;
      clock.classList.toggle('hidden', !inFull);
      if (inFull) {
        const now = new Date();
        clock.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      }
    }, 1000);
  }
};

//空格控制音乐
document.addEventListener("keydown", function (event) {
  //暂停开启音乐
  if (event.code === "Space") {
    event.preventDefault();
    ap.toggle();

  };
  //切换下一曲
  if (event.keyCode === 39) {
    event.preventDefault();
    ap.skipForward();

  };
  //切换上一曲
  if (event.keyCode === 37) {
    event.preventDefault();
    ap.skipBack();

  }
  //增加音量
  if (event.keyCode === 38) {
    if (volume <= 1) {
      volume += 0.1;
      ap.volume(volume, true);

    }
  }
  //减小音量
  if (event.keyCode === 40) {
    if (volume >= 0) {
      volume += -0.1;
      ap.volume(volume, true);

    }
  }
});

// 监听窗口大小变化
window.addEventListener('resize', function() {
  if (window.innerWidth > 768) {
    ap.list.show();
  } else {
    ap.list.hide();
  }

});

// 调用初始化
heo.init();
setInterval(() => pageEnhancer.initOnce(), 300);
