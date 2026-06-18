(function(){
  'use strict';

  /* ===================== Конфигурация таймеров ===================== */

  var OVERTIME_LIMIT_SEC = 2 * 3600;   // максимум перерасхода — 2 часа
  var WARN_THRESHOLD_SEC = 20 * 60;    // желтый — за 20 минут до конца
  var DANGER_THRESHOLD_SEC = 5 * 60;   // красный — за 5 минут до конца
  var STORAGE_KEY = 'timers_state_v1';

  var TIMERS = [
    { id: 'ddz',      name: 'ДДЗ',                 duration: hms(2, 0, 0) },
    { id: 'srz',      name: 'СРЗ',                 duration: hms(1, 30, 0) },
    { id: 'service',  name: 'Сервис',               duration: hms(3, 0, 0) },
    { id: 'to',       name: 'ТО',                  duration: hms(3, 0, 0) },
    { id: 'ppk',      name: 'ППК',                 duration: hms(3, 0, 0) },
    { id: 'peregon',  name: 'Перегон после СТО',    duration: hms(2, 0, 0) },
    { id: 'parking',  name: 'Перепарковка',         duration: hms(0, 30, 0) }
  ];

  function hms(h, m, s){ return h * 3600 + m * 60 + s; }

  /* ===================== Состояние ===================== */

  // Состояние каждого таймера:
  //   running: bool
  //   startedAt: timestamp (ms) когда был запущен, null если не запущен
  // Текущее оставшееся/перерасходное время всегда вычисляется из startedAt,
  // поэтому таймер идет верно даже если вкладка была закрыта.

  var state = loadState();

  function defaultState(){
    var s = {};
    TIMERS.forEach(function(t){
      s[t.id] = { running: false, startedAt: null };
    });
    return s;
  }

  function loadState(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return defaultState();
      var parsed = JSON.parse(raw);
      var s = defaultState();
      TIMERS.forEach(function(t){
        if(parsed[t.id]){
          s[t.id].running = !!parsed[t.id].running;
          s[t.id].startedAt = parsed[t.id].startedAt || null;
        }
      });
      return s;
    }catch(e){
      return defaultState();
    }
  }

  function saveState(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }catch(e){ /* хранилище недоступно — продолжаем без сохранения */ }
  }

  /* ===================== Утилиты времени ===================== */

  function formatTime(totalSeconds){
    totalSeconds = Math.max(0, Math.round(totalSeconds));
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    function pad(n){ return n < 10 ? '0' + n : '' + n; }
    if(h > 0){
      return pad(h) + ':' + pad(m) + ':' + pad(s);
    }
    return pad(m) + ':' + pad(s);
  }

  /* Возвращает {phase, displaySeconds}
     phase: 'idle' | 'running' | 'overtime' (овертайм считается отдельной фазой) */
  function computeTimerView(timerConf, timerState, now){
    if(!timerState.running || !timerState.startedAt){
      return { phase: 'idle', displaySeconds: timerConf.duration, remaining: timerConf.duration };
    }
    var elapsed = (now - timerState.startedAt) / 1000;
    var remaining = timerConf.duration - elapsed;
    if(remaining > 0){
      return { phase: 'running', displaySeconds: remaining, remaining: remaining };
    }
    var overtime = Math.min(-remaining, OVERTIME_LIMIT_SEC);
    return { phase: 'overtime', displaySeconds: overtime, remaining: 0, overtimeCapped: (-remaining) >= OVERTIME_LIMIT_SEC };
  }

  /* ===================== Звук + вибрация ===================== */

  var audioCtx = null;
  function ensureAudioCtx(){
    if(!audioCtx){
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if(Ctx) audioCtx = new Ctx();
    }
    return audioCtx;
  }

  // Разблокируем аудио по первому касанию пользователя (политика браузеров)
  document.addEventListener('touchstart', function unlock(){
    var ctx = ensureAudioCtx();
    if(ctx && ctx.state === 'suspended') ctx.resume();
    document.removeEventListener('touchstart', unlock);
  }, { once: true, passive: true });

  function playAlertSound(){
    var ctx = ensureAudioCtx();
    if(!ctx) return;
    if(ctx.state === 'suspended') ctx.resume();
    var now = ctx.currentTime;
    [0, 0.18, 0.36].forEach(function(offset){
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.16);
    });
  }

  function vibrate(){
    if(navigator.vibrate) navigator.vibrate([120, 80, 120, 80, 120]);
  }

  function fireAlert(){
    playAlertSound();
    vibrate();
  }

  /* ===================== Рендер карточек ===================== */

  var listEl = document.getElementById('cardList');
  var cardRefs = {}; // id -> { trackEl, knobEl, timeEl, nameEl, sublabelEl, trackWidth }
  var alertedThisRun = {}; // id -> bool, чтобы не повторять сигнал каждый тик после входа в овертайм
  var isFirstRender = true;

  TIMERS.forEach(function(t){
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="card-top">' +
        '<span class="card-name" data-role="name">' + t.name + '</span>' +
        '<span class="card-duration">' + formatTime(t.duration) + '</span>' +
      '</div>' +
      '<div class="track" data-role="track">' +
        '<div class="track-label">' +
          '<span class="track-time" data-role="time">' + formatTime(t.duration) + '</span>' +
          '<span class="track-sublabel" data-role="sublabel">Перерасход</span>' +
        '</div>' +
        '<div class="knob" data-role="knob">' +
          '<svg class="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' +
          '<svg class="icon-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>' +
        '</div>' +
      '</div>';
    listEl.appendChild(card);

    cardRefs[t.id] = {
      card: card,
      track: card.querySelector('[data-role="track"]'),
      knob: card.querySelector('[data-role="knob"]'),
      time: card.querySelector('[data-role="time"]'),
      name: card.querySelector('[data-role="name"]'),
      sublabel: card.querySelector('[data-role="sublabel"]')
    };

    alertedThisRun[t.id] = false;
  });

  /* ===================== Отрисовка состояния ===================== */

  function knobTravel(trackEl){
    // расстояние, на которое смещается кружок (56px) внутри трека
    return trackEl.clientWidth - 56 - 8; // минус padding слева/справа (4+4)
  }

  /* ===================== Тема ===================== */

  var THEME_KEY = 'timers_theme_v1';
  var themeToggleBtn = document.getElementById('themeToggle');
  var sunIconHTML = '<svg class="icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><g stroke-width="1.6"><line x1="12" y1="2" x2="12" y2="4.5" stroke="currentColor"/><line x1="12" y1="19.5" x2="12" y2="22" stroke="currentColor"/><line x1="2" y1="12" x2="4.5" y2="12" stroke="currentColor"/><line x1="19.5" y1="12" x2="22" y2="12" stroke="currentColor"/></g></svg>';
  var moonIconHTML = '<svg class="icon-moon" viewBox="0 0 24 24"><path d="M20.5 14.5a8.5 8.5 0 1 1-9-12 7 7 0 0 0 9 12z"/></svg>';

  function applyTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    var dot = themeToggleBtn.querySelector('.dot');
    dot.innerHTML = theme === 'dark' ? moonIconHTML : sunIconHTML;
  }

  function loadTheme(){
    try{
      var saved = localStorage.getItem(THEME_KEY);
      if(saved === 'dark' || saved === 'light') return saved;
    }catch(e){}
    return 'light';
  }

  function saveTheme(theme){
    try{ localStorage.setItem(THEME_KEY, theme); }catch(e){}
  }

  var currentTheme = loadTheme();
  applyTheme(currentTheme);

  themeToggleBtn.addEventListener('click', function(){
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(currentTheme);
    saveTheme(currentTheme);
  });

  function render(){
    var now = Date.now();

    TIMERS.forEach(function(t){
      var ref = cardRefs[t.id];
      var ts = state[t.id];
      var view = computeTimerView(t, ts, now);

      var track = ref.track;
      var knob = ref.knob;

      // На самом первом рендере (загрузка/перезагрузка страницы) отключаем
      // CSS-transition у кружка, чтобы он появился сразу в нужной точке,
      // а не "прилетал" туда анимацией из позиции 0.
      if(isFirstRender){
        knob.style.transition = 'none';
      }

      track.classList.remove('is-running', 'is-overtime', 'state-warn', 'state-danger', 'dragging');
      ref.name.classList.remove('state-warn', 'state-danger');

      if(view.phase === 'idle'){
        knob.style.transform = 'translateX(0px)';
        ref.time.textContent = formatTime(t.duration);
      }
      else if(view.phase === 'running'){
        track.classList.add('is-running');
        knob.style.transform = 'translateX(' + knobTravel(track) + 'px)';
        ref.time.textContent = formatTime(view.remaining);

        if(view.remaining <= DANGER_THRESHOLD_SEC){
          track.classList.add('state-danger');
          ref.name.classList.add('state-danger');
        } else if(view.remaining <= WARN_THRESHOLD_SEC){
          track.classList.add('state-warn');
          ref.name.classList.add('state-warn');
        }
      }
      else if(view.phase === 'overtime'){
        track.classList.add('is-running', 'is-overtime');
        knob.style.transform = 'translateX(' + knobTravel(track) + 'px)';
        ref.time.textContent = formatTime(view.displaySeconds);

        if(!alertedThisRun[t.id]){
          alertedThisRun[t.id] = true;
          fireAlert();
        }
      }

      ref.card.classList.toggle('is-active', view.phase === 'running' || view.phase === 'overtime');
    });

    reorderCards();

    if(isFirstRender){
      // Возвращаем transition на следующем кадре, чтобы дальнейшие
      // запуски/остановки таймера снова анимировались как обычно.
      requestAnimationFrame(function(){
        TIMERS.forEach(function(t){
          cardRefs[t.id].knob.style.transition = '';
        });
      });
      isFirstRender = false;
    }
  }

  /* ===================== Перенос активного таймера наверх (FLIP) ===================== */

  function reorderCards(){
    // Собираем позиции до изменения порядка
    var firstRects = {};
    TIMERS.forEach(function(t){
      firstRects[t.id] = cardRefs[t.id].card.getBoundingClientRect();
    });

    // Активные таймеры (running или overtime) поднимаем наверх, остальные — по исходному порядку
    var activeIds = TIMERS.filter(function(t){ return cardRefs[t.id].card.classList.contains('is-active'); }).map(function(t){ return t.id; });
    var idleIds = TIMERS.filter(function(t){ return !cardRefs[t.id].card.classList.contains('is-active'); }).map(function(t){ return t.id; });
    var newOrder = activeIds.concat(idleIds);

    var orderChanged = false;
    newOrder.forEach(function(id, index){
      var ref = cardRefs[id];
      var desiredOrder = String(index);
      if(ref.card.style.order !== desiredOrder){
        orderChanged = true;
      }
      ref.card.style.order = desiredOrder;
    });

    if(!orderChanged) return;

    // FLIP: измеряем новые позиции, инвертируем смещение через transform,
    // затем анимируем к нулевому смещению — карточка "перелетает" на новое место.
    newOrder.forEach(function(id){
      var ref = cardRefs[id];
      var card = ref.card;
      var first = firstRects[id];
      var last = card.getBoundingClientRect();
      var dx = first.left - last.left;
      var dy = first.top - last.top;

      if(dx === 0 && dy === 0) return;

      card.style.transition = 'none';
      card.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';

      requestAnimationFrame(function(){
        card.style.transition = 'transform 0.4s cubic-bezier(0.2,0.8,0.2,1)';
        card.style.transform = '';
      });
    });
  }

  /* ===================== Действия ===================== */

  function startTimer(id){
    state[id].running = true;
    state[id].startedAt = Date.now();
    alertedThisRun[id] = false;
    saveState();
    render();
  }

  function stopTimer(id){
    state[id].running = false;
    state[id].startedAt = null;
    alertedThisRun[id] = false;
    saveState();
    render();
  }

  document.getElementById('resetAllBtn').addEventListener('click', function(){
    TIMERS.forEach(function(t){ stopTimer(t.id); });
  });

  /* ===================== Свайп ===================== */

  TIMERS.forEach(function(t){
    var ref = cardRefs[t.id];
    attachSwipe(t.id, ref);
  });

  function attachSwipe(id, ref){
    var track = ref.track;
    var knob = ref.knob;

    var dragging = false;
    var startX = 0;
    var currentX = 0;
    var travel = 0;
    var wasRunningAtStart = false;

    function getRunning(){ return !!state[id].running; }

    function onPointerDown(e){
      // игнорируем повторный палец / правую кнопку мыши
      if(e.pointerType === 'mouse' && e.button !== 0) return;

      dragging = true;
      track.classList.add('dragging');
      travel = knobTravel(track);
      wasRunningAtStart = getRunning();
      startX = e.clientX;
      currentX = wasRunningAtStart ? travel : 0;
      knob.setPointerCapture && knob.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    function onPointerMove(e){
      if(!dragging) return;
      var dx = e.clientX - startX;
      var base = wasRunningAtStart ? travel : 0;
      var pos = base + dx;
      if(pos < 0) pos = 0;
      if(pos > travel) pos = travel;
      currentX = pos;
      knob.style.transform = 'translateX(' + pos + 'px)';
      e.preventDefault();
    }

    function onPointerUp(e){
      if(!dragging) return;
      dragging = false;
      track.classList.remove('dragging');

      var ratio = travel > 0 ? currentX / travel : 0;
      var shouldBeRunning;

      if(wasRunningAtStart){
        // обратный свайп: останавливаем, если ушли влево хотя бы на треть пути
        shouldBeRunning = ratio > (1 - 1/3);
      } else {
        // прямой свайп: запускаем, если прошли хотя бы треть пути
        shouldBeRunning = ratio > 1/3;
      }

      if(shouldBeRunning && !wasRunningAtStart){
        startTimer(id);
      } else if(!shouldBeRunning && wasRunningAtStart){
        stopTimer(id);
      } else {
        // отмена жеста — возвращаем в прежнее состояние визуально
        render();
      }
    }

    knob.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    // Клик по треку (не по кружку) — тоже воспринимаем как намерение свайпа в сторону клика,
    // но безопаснее не делать ничего: просим именно тащить кружок.
  }

  /* ===================== Тикер и пересчёт на возврат в видимость ===================== */

  function tick(){
    render();
  }

  setInterval(tick, 500);
  render();

  document.addEventListener('visibilitychange', function(){
    if(!document.hidden) render();
  });

  window.addEventListener('resize', render);

})();
