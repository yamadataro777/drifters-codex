/**
 * The Drifter's Codex — app.js
 * 5画面の制御・3ゲート学習・SRS・SVG海図・録音・旅日記
 */
(function () {
  "use strict";

  // ========== Constants ==========
  const STORAGE_KEY = "driftersCodex.progress.v1";
  const RECORDING_KEY = "driftersCodex.recordings.v1";
  const STREAK_KEY = "driftersCodex.streak.v1";
  const SESSION_KEY = "driftersCodex.session.v1";
  const STORY_KEY = "driftersCodex.story.v1";

  const GATE_ENCOUNTER = 1;
  const GATE_REUNION = 2;
  const GATE_RECALL = 3;
  const GATE_MASTERED = 4;

  // SRS Leitner boxes (day offsets)
  const SRS_INTERVALS_HOURS = [24, 72, 168, 336, 720];  // 1, 3, 7, 14, 30 days

  // タイプライター速度 (ms / 文字)
  const TYPE_SPEED = 38;

  // ========== State ==========
  const state = {
    currentChapterId: null,
    queue: [],
    queueIndex: 0,
    sessionWords: new Set(),
    sessionCorrect: 0,
    sessionTotal: 0,
    sessionStartTs: 0,
    chosenIndex: null,
    pendingRustVisit: false,
    // 物語タイプライター
    story: {
      chapterId: null,
      fragIdx: 0,
      segIdx: 0,
      typingTimer: null,
      typingAbort: false,
      pendingResolve: null,  // interactive ポーズの resolver
      pendingHeadword: null,
      streak: 0,           // 連続正解
      maxStreak: 0,
      fragCorrect: 0,      // 現在の段の正答数
      fragTotal: 0,        // 現在の段の interactive 総数
    },
  };

  // ========== DOM ==========
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const screens = {
    atlas: $("#screen-atlas"),
    landing: $("#screen-landing"),
    stele: $("#screen-stele"),
    voyage: $("#screen-voyage"),
    epilogue: $("#screen-epilogue"),
  };
  function showScreen(name) {
    Object.values(screens).forEach((el) => el.classList.remove("active"));
    screens[name].classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ========== Progress storage ==========
  function loadProgress() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveProgress(p) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }

  function getWordState(headword) {
    const p = loadProgress();
    return p[headword] || { gate: GATE_ENCOUNTER, history: [], srs_box: 0, next_visit_ts: 0, mastered_ts: 0 };
  }

  function recordOutcome(headword, gate, correct) {
    const p = loadProgress();
    const s = p[headword] || { gate: GATE_ENCOUNTER, history: [], srs_box: 0, next_visit_ts: 0, mastered_ts: 0 };
    s.history.push({ ts: Date.now(), gate, correct });
    s.history = s.history.slice(-20);

    if (correct) {
      if (s.gate < GATE_MASTERED) {
        s.gate = Math.min(GATE_MASTERED, (s.gate || GATE_ENCOUNTER) + 1);
      }
      if (s.gate >= GATE_MASTERED) {
        if (!s.mastered_ts) s.mastered_ts = Date.now();
        // SRS bump
        const oldBox = s.srs_box || 0;
        s.srs_box = Math.min(SRS_INTERVALS_HOURS.length, oldBox + 1);
        const hours = SRS_INTERVALS_HOURS[Math.min(s.srs_box - 1, SRS_INTERVALS_HOURS.length - 1)];
        s.next_visit_ts = Date.now() + hours * 3600 * 1000;
      }
    } else {
      if (s.gate >= GATE_MASTERED) {
        // 磨き直し失敗: box ひとつ戻る
        s.srs_box = Math.max(1, (s.srs_box || 1) - 1);
        const hours = SRS_INTERVALS_HOURS[s.srs_box - 1];
        s.next_visit_ts = Date.now() + hours * 3600 * 1000;
      } else {
        s.gate = Math.max(GATE_ENCOUNTER, (s.gate || GATE_ENCOUNTER) - 1);
      }
    }
    p[headword] = s;
    saveProgress(p);
  }

  function isMastered(headword) {
    return getWordState(headword).gate >= GATE_MASTERED;
  }
  function isRusty(headword) {
    const s = getWordState(headword);
    return s.gate >= GATE_MASTERED && s.next_visit_ts && Date.now() >= s.next_visit_ts && s.srs_box < SRS_INTERVALS_HOURS.length;
  }
  function chapterRustyCount(chapter) {
    return chapter.words.filter(w => isRusty(w.headword)).length;
  }
  function chapterMasteredCount(chapter) {
    return chapter.words.filter(w => isMastered(w.headword)).length;
  }
  function chapterProgress(chapter) {
    const mastered = chapterMasteredCount(chapter);
    return {
      mastered,
      total: chapter.words.length,
      percent: Math.round((mastered / chapter.words.length) * 100),
      rusty: chapterRustyCount(chapter),
    };
  }
  function overallProgress() {
    let mastered = 0, total = 0, rusty = 0;
    for (const meta of window.DRIFTERS_MANIFEST.chapters) {
      const ch = window.DRIFTERS_DATA[meta.id];
      if (!ch) continue;
      total += ch.words.length;
      for (const w of ch.words) {
        if (isMastered(w.headword)) mastered += 1;
        if (isRusty(w.headword)) rusty += 1;
      }
    }
    return { mastered, total, rusty };
  }

  // ========== Streak ==========
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  function loadStreak() {
    try { return JSON.parse(localStorage.getItem(STREAK_KEY) || '{"count":0,"lastDate":null}'); }
    catch { return { count: 0, lastDate: null }; }
  }
  function bumpStreak() {
    const s = loadStreak();
    const today = todayStr();
    if (s.lastDate === today) return s;
    if (s.lastDate) {
      const diff = Math.round((new Date(today) - new Date(s.lastDate)) / 86400000);
      s.count = diff === 1 ? s.count + 1 : 1;
    } else { s.count = 1; }
    s.lastDate = today;
    localStorage.setItem(STREAK_KEY, JSON.stringify(s));
    return s;
  }

  function renderHeaderStats() {
    const s = loadStreak();
    $("#streak-count").textContent = s.count;
    const o = overallProgress();
    $("#depth-count").textContent = `${o.mastered}/${o.total}`;
    $("#rust-count").textContent = o.rusty;
    $("#rust-pill").setAttribute("data-zero", o.rusty === 0 ? "true" : "false");
    const btn = $("#resume-rust-btn");
    btn.setAttribute("data-show", o.rusty > 0 ? "true" : "false");
    $("#resume-rust-count").textContent = o.rusty;
  }

  // ========== SVG Atlas ==========
  function renderAtlas() {
    const svg = $("#atlas-map");
    svg.innerHTML = "";
    const W = 900, H = 540;
    // 16島の配置: 「のたうつ航路」風に
    const positions = [
      [100, 110], [240, 80], [400, 100], [560, 75], [720, 130],
      [800, 230], [720, 320], [580, 370], [430, 340],
      [290, 380], [150, 340], [80, 230],
      [200, 195], [350, 200], [510, 230], [680, 230],
    ];

    // 海の波紋(背景)
    for (let r = 80; r < 500; r += 60) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      c.setAttribute("cx", W/2);
      c.setAttribute("cy", H/2);
      c.setAttribute("rx", r * 1.4);
      c.setAttribute("ry", r * 0.7);
      c.setAttribute("class", "sea-wave");
      svg.appendChild(c);
    }
    // 航路(順序通り、点線)
    const pathD = positions.map((p,i)=> (i===0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
    const path = document.createElementNS("http://www.w3.org/2000/svg","path");
    path.setAttribute("d", pathD);
    path.setAttribute("class", "journey-path");
    svg.appendChild(path);

    window.DRIFTERS_MANIFEST.chapters.forEach((meta, i) => {
      const [cx, cy] = positions[i];
      const ch = window.DRIFTERS_DATA[meta.id];
      const prog = ch ? chapterProgress(ch) : { mastered: 0, total: meta.word_count, percent: 0, rusty: 0 };
      const g = document.createElementNS("http://www.w3.org/2000/svg","g");
      let cls = "island-node";
      if (prog.percent >= 100) cls += " lit";
      else if (prog.mastered > 0) cls += " partial";
      if (prog.rusty > 0) cls += " rust";
      g.setAttribute("class", cls);
      g.setAttribute("transform", `translate(${cx},${cy})`);
      g.addEventListener("click", () => openChapter(meta.id));

      const c = document.createElementNS("http://www.w3.org/2000/svg","circle");
      c.setAttribute("r", 24); c.setAttribute("class","island-circle");
      g.appendChild(c);

      const num = document.createElementNS("http://www.w3.org/2000/svg","text");
      num.setAttribute("y", 5); num.setAttribute("class","island-num"); num.textContent = meta.index;
      g.appendChild(num);

      const name = document.createElementNS("http://www.w3.org/2000/svg","text");
      name.setAttribute("y", 44); name.setAttribute("class","island-name"); name.textContent = meta.island_name;
      g.appendChild(name);

      if (prog.mastered > 0) {
        const pct = document.createElementNS("http://www.w3.org/2000/svg","text");
        pct.setAttribute("y", 58); pct.setAttribute("class","island-pct"); pct.textContent = `${prog.percent}%`;
        g.appendChild(pct);
      }

      svg.appendChild(g);
    });
  }

  function renderChapterGrid() {
    const host = $("#chapter-grid");
    host.innerHTML = "";
    window.DRIFTERS_MANIFEST.chapters.forEach((meta) => {
      const ch = window.DRIFTERS_DATA[meta.id];
      const prog = ch ? chapterProgress(ch) : { mastered: 0, total: meta.word_count, percent: 0, rusty: 0 };
      const card = document.createElement("div");
      card.className = "chapter-card" + (prog.rusty > 0 ? " rust" : "");
      card.innerHTML = `
        <div class="ch-index">Chapter ${String(meta.index).padStart(2,"0")}</div>
        <div class="ch-name">${escapeHtml(meta.island_name)}</div>
        <div class="ch-sub">${escapeHtml(meta.subtitle)}</div>
        <div class="ch-bar"><div style="width:${prog.percent}%"></div></div>
        <div class="ch-meta">
          <span>${prog.mastered} / ${prog.total} 訳済</span>
          ${prog.rusty > 0 ? `<span style="color:var(--rust)">⌛ ${prog.rusty}</span>` : `<span></span>`}
        </div>
      `;
      card.addEventListener("click", () => openChapter(meta.id));
      host.appendChild(card);
    });
  }

  // ========== Landing ==========
  function openChapter(chapterId) {
    abortStoryTypewriter();
    state.currentChapterId = chapterId;
    const ch = window.DRIFTERS_DATA[chapterId];
    const meta = window.DRIFTERS_MANIFEST.chapters.find(m => m.id === chapterId);
    $("#landing-title").textContent = `Chapter ${meta.index}: ${meta.island_name}`;
    $("#landing-subtitle").textContent = meta.subtitle;
    const prog = chapterProgress(ch);
    $("#landing-bar").style.width = `${prog.percent}%`;
    $("#landing-text").textContent = `${prog.mastered} / ${prog.total} 訳済 (${prog.rusty} 磨き直し待ち)`;
    $("#landing-rust-count").textContent = prog.rusty;
    $("#landing-rust-btn").style.display = prog.rusty > 0 ? "" : "none";

    renderStoryPanel(ch);
    renderReviewButtons(ch);
    renderSteleGrid(ch);

    showScreen("landing");
  }

  // ===== Story Panel (v2 タイプライター) =====
  function loadStoryProgress() {
    try { return JSON.parse(localStorage.getItem(STORY_KEY) || "{}"); } catch { return {}; }
  }
  function saveStoryProgress(obj) {
    localStorage.setItem(STORY_KEY, JSON.stringify(obj));
  }
  function getChapterStory(chapterId) {
    const all = loadStoryProgress();
    return all[chapterId] || { fragIdx: 0, started: false };
  }
  function setChapterStory(chapterId, patch) {
    const all = loadStoryProgress();
    all[chapterId] = { ...(all[chapterId] || { fragIdx: 0, started: false }), ...patch };
    saveStoryProgress(all);
  }

  function renderStoryPanel(ch) {
    const sp = getChapterStory(ch.id);
    state.story.chapterId = ch.id;
    state.story.fragIdx = sp.fragIdx || 0;
    state.story.segIdx = 0;
    const fragIdx = state.story.fragIdx;
    const totalFrags = ch.fragments.length;
    const isDone = fragIdx >= totalFrags;
    const startBtn = $("#story-start-btn");
    const nextBtn = $("#story-next-frag-btn");
    const skipBtn = $("#story-skip-btn");
    const replayBtn = $("#story-replay-btn");
    const stage = $("#story-stage");
    const label = $("#story-fragment-label");

    stage.innerHTML = "";

    if (!sp.started) {
      // 初回
      label.textContent = "Press 「物語を始める」";
      startBtn.hidden = false;
      startBtn.textContent = "📖 物語を始める";
      nextBtn.hidden = true; skipBtn.hidden = true; replayBtn.hidden = true;
      // 既訳セグメントは前回までで読了している可能性 → 段0の plain な静的プレビューを少し見せる
      const frag0 = ch.fragments[0];
      if (frag0) renderStaticFragment(stage, frag0, ch);
      return;
    }

    if (isDone) {
      label.textContent = `物語完了 (${totalFrags}/${totalFrags} 段)`;
      startBtn.hidden = true; nextBtn.hidden = true; skipBtn.hidden = true; replayBtn.hidden = false;
      // 全段を静的に表示
      ch.fragments.forEach(f => renderStaticFragment(stage, f, ch, true));
      return;
    }

    const frag = ch.fragments[fragIdx];
    label.textContent = `第 ${fragIdx + 1} 段 (碑 ${frag.threshold} 訳了で解放)`;
    // 進行中フラグメントを表示
    // 既読の前段は静的に表示してスクロール感を出す
    for (let i = 0; i < fragIdx; i++) {
      renderStaticFragment(stage, ch.fragments[i], ch, true);
    }
    // 現在の段の再生コンテナ
    const current = document.createElement("div");
    current.className = "fragment-active";
    stage.appendChild(current);
    state.story._activeNode = current;

    startBtn.hidden = false;
    startBtn.textContent = fragIdx === 0 ? "📖 物語を始める" : "▶ この段を読む";
    nextBtn.hidden = true;
    skipBtn.hidden = false;
    replayBtn.hidden = true;
  }

  function renderStaticFragment(host, frag, ch, dimmed) {
    const block = document.createElement("div");
    block.className = "fragment-static" + (dimmed ? " dim" : "");
    block.style.opacity = dimmed ? "0.7" : "1";
    block.style.marginBottom = "14px";
    for (const seg of frag.segments) {
      if (seg.type === "text") {
        const span = document.createElement("span");
        span.textContent = seg.text;
        block.appendChild(span);
      } else if (seg.type === "interactive") {
        const ws = getWordState(seg.headword);
        const chip = document.createElement("span");
        // mastered のみ静的 solved 表示。それ未満は未解として表示(再訪時に再ポーズ可能)
        if (ws.gate >= GATE_MASTERED) {
          chip.className = "story-chip solved";  // fresh 無し → アニメ無し
          chip.innerHTML = `${escapeHtml(seg.headword)}<span class="chip-en">${escapeHtml(seg.jp_phrase)}</span>`;
        } else {
          chip.className = "story-chip";
          chip.textContent = seg.headword;
        }
        block.appendChild(chip);
      }
    }
    host.appendChild(block);
  }

  // タイプライター再生
  async function startStoryTypewriter() {
    const ch = window.DRIFTERS_DATA[state.story.chapterId];
    const fragIdx = state.story.fragIdx;
    if (fragIdx >= ch.fragments.length) return;
    setChapterStory(ch.id, { started: true });
    $("#story-start-btn").hidden = true;
    $("#story-skip-btn").hidden = false;
    state.story.typingAbort = false;
    // 段ごとのカウンタをリセット
    state.story.fragCorrect = 0;
    state.story.fragTotal = 0;
    const frag = ch.fragments[fragIdx];
    const node = state.story._activeNode;
    node.innerHTML = "";

    // 進捗対応(現在の閾値での gate1 達成数を再計算)
    for (const seg of frag.segments) {
      if (state.story.typingAbort) return;
      if (seg.type === "text") {
        await typeText(node, seg.text);
      } else if (seg.type === "interactive") {
        await handleInteractiveSegment(node, seg, ch);
      }
    }
    // 段完了 → 次へ
    await sleep(300);
    finishCurrentFragment(ch);
  }

  function typeText(node, text) {
    return new Promise((resolve) => {
      const span = document.createElement("span");
      const cursor = document.createElement("span");
      cursor.className = "typed-cursor";
      node.appendChild(span);
      node.appendChild(cursor);
      let i = 0;
      const tick = () => {
        if (state.story.typingAbort) { cursor.remove(); return resolve(); }
        if (i >= text.length) { cursor.remove(); return resolve(); }
        span.textContent += text[i++];
        state.story.typingTimer = setTimeout(tick, TYPE_SPEED);
      };
      tick();
    });
  }

  function handleInteractiveSegment(node, seg, ch) {
    return new Promise((resolve) => {
      const ws = getWordState(seg.headword);
      // mastered 済み(全ゲート通過)の語のみ自動 solved 化(静的・無報酬)
      if (ws.gate >= GATE_MASTERED) {
        const chip = makeChip(seg, "solved");  // .solved のみ、fresh 無し → アニメ発火しない
        node.appendChild(chip);
        return resolve();
      }
      // 未 mastered の語は、過去に物語で解いたことがあっても毎回ポーズして練習
      state.story.fragTotal += 1;
      const chip = makeChip(seg, "pending");
      node.appendChild(chip);
      openInlineModal(seg, ch, (result) => {
        chip.className = result.correct ? "story-chip solved solved-fresh" : "story-chip skipped";
        chip.innerHTML = `${escapeHtml(seg.headword)}<span class="chip-en">${escapeHtml(seg.jp_phrase)}</span>`;
        if (result.correct) {
          state.story.fragCorrect += 1;
          state.story.streak += 1;
          if (state.story.streak > state.story.maxStreak) state.story.maxStreak = state.story.streak;
          showComboFloat(chip, state.story.streak);
          // アニメ完了後に fresh クラスを外して再発火防止
          setTimeout(() => chip.classList.remove("solved-fresh"), 1500);
        } else {
          state.story.streak = 0;
        }
        renderHeaderStats();
        resolve();
      });
    });
  }

  function showComboFloat(chip, streak) {
    if (streak < 2) return;
    const el = document.createElement("span");
    el.className = "combo-float";
    if (streak >= 7) { el.classList.add("huge"); el.textContent = `🔥 ${streak}連続! 圧巻`; }
    else if (streak >= 4) { el.classList.add("big"); el.textContent = `✦ ${streak}連続`; }
    else { el.textContent = `× ${streak}`; }
    chip.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }
  function makeChip(seg, cls) {
    const chip = document.createElement("span");
    chip.className = `story-chip ${cls}`;
    if (cls === "solved" || cls === "skipped") {
      chip.innerHTML = `${escapeHtml(seg.headword)}<span class="chip-en">${escapeHtml(seg.jp_phrase)}</span>`;
    } else {
      chip.textContent = seg.headword;
    }
    return chip;
  }

  // 日本語訳の許容回答を構築
  function buildAcceptedJp(seg, ch) {
    const set = new Set();
    if (seg.jp_phrase) set.add(seg.jp_phrase);
    const w = ch.words.find(x => x.headword === seg.headword);
    if (w && w.jp_meaning) {
      w.jp_meaning.split(/[;;；]/).forEach(p => { const t = p.trim(); if (t) set.add(t); });
    }
    return [...set];
  }
  // 末尾の活用・送り仮名を緩く除去して正規化
  function normalizeJp(s) {
    return String(s).trim().replace(/[\s　]/g, "")
      .replace(/(する|します|した|して|な$|の$|だ$|である$|として$|とする$)$/, "");
  }
  function jpMatch(input, accepted) {
    const ni = normalizeJp(input);
    if (!ni) return false;
    return accepted.some(a => {
      const na = normalizeJp(a);
      if (!na) return false;
      if (na === ni) return true;
      // 片方が他方を含む(2文字以上必要)
      if (na.length >= 2 && ni.length >= 2 && (na.includes(ni) || ni.includes(na))) return true;
      return false;
    });
  }

  // 入力モーダル(英単語 → 日本語訳)
  function openInlineModal(seg, ch, callback) {
    const modal = $("#inline-modal");
    const enEl = $("#im-en");
    const posEl = $("#im-pos");
    const input = $("#im-input");
    const feedback = $("#im-feedback");
    const submitBtn = $("#im-submit-btn");
    const revealBtn = $("#im-reveal-btn");

    enEl.textContent = seg.headword;
    const w = ch.words.find(x => x.headword === seg.headword);
    posEl.textContent = w ? w.pos : "";

    input.value = ""; input.disabled = false;
    feedback.textContent = ""; feedback.className = "im-feedback";
    submitBtn.disabled = false;
    revealBtn.disabled = false;
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 50);

    const accepted = buildAcceptedJp(seg, ch);
    let attempts = 0;
    const cleanup = () => {
      modal.classList.add("hidden");
      submitBtn.onclick = null;
      revealBtn.onclick = null;
      input.onkeydown = null;
    };
    const accept = () => {
      const raw = input.value;
      if (!raw.trim()) { feedback.textContent = "入力してください"; feedback.className = "im-feedback wrong"; return; }
      const correct = jpMatch(raw, accepted);
      attempts += 1;
      recordOutcome(seg.headword, GATE_ENCOUNTER, correct);
      state.sessionWords.add(seg.headword); state.sessionTotal += 1;
      if (correct) state.sessionCorrect += 1;
      if (correct) {
        feedback.textContent = `✓ ${seg.jp_phrase}`;
        feedback.className = "im-feedback correct";
        setTimeout(() => { cleanup(); callback({ correct: true, skipped: false }); }, 600);
      } else {
        if (attempts < 2) {
          const hint = accepted[0] ? `(ヒント: ${accepted[0].length}文字程度)` : "";
          feedback.textContent = `✗ もう一度 ${hint}`;
          feedback.className = "im-feedback wrong";
          input.select();
        } else {
          feedback.textContent = `正解: ${accepted.join(" / ")}`;
          feedback.className = "im-feedback wrong";
          setTimeout(() => { cleanup(); callback({ correct: false, skipped: true }); }, 1200);
        }
      }
    };
    submitBtn.onclick = accept;
    revealBtn.onclick = () => {
      recordOutcome(seg.headword, GATE_ENCOUNTER, false);
      state.sessionWords.add(seg.headword); state.sessionTotal += 1;
      feedback.textContent = `正解: ${accepted.join(" / ")}`;
      feedback.className = "im-feedback wrong";
      setTimeout(() => { cleanup(); callback({ correct: false, skipped: true }); }, 900);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); accept(); }
    };
  }

  function finishCurrentFragment(ch) {
    const fragIdx = state.story.fragIdx;
    const newIdx = fragIdx + 1;
    setChapterStory(ch.id, { fragIdx: newIdx, started: true });
    state.story.fragIdx = newIdx;
    $("#story-skip-btn").hidden = true;
    const correct = state.story.fragCorrect;
    const total = state.story.fragTotal;
    const isLast = newIdx >= ch.fragments.length;
    const isPerfect = total > 0 && correct === total;

    // 章 mastered 100% で voyage out へ → 章クリア演出は voyage 側に任せる
    const chapterDone = isLast && chapterProgress(ch).percent >= 100;

    // 段クリア演出(章クリアじゃない & 実際に1問以上タイプライターで通過したとき)
    if (!chapterDone && total > 0) {
      showStageClearOverlay(fragIdx + 1, correct, total, isPerfect, isLast);
    }

    if (isLast) {
      // 全段完了
      $("#story-fragment-label").textContent = `物語完了 (${ch.fragments.length}/${ch.fragments.length} 段)`;
      $("#story-next-frag-btn").hidden = true;
      $("#story-replay-btn").hidden = false;
      renderAtlas(); renderChapterGrid();
      if (chapterDone) {
        // 章クリア → voyage out (オーバーレイ後に発火)
        setTimeout(() => showVoyageOut(ch), 2200);
      }
      return;
    }
    // 次の段準備
    const nextBtn = $("#story-next-frag-btn");
    nextBtn.hidden = false;
    nextBtn.textContent = `▶ 第 ${newIdx + 1} 段へ`;
    renderReviewButtons(ch);
    renderSteleGrid(ch);
  }

  // ===== 段クリア演出 =====
  function showStageClearOverlay(stageNum, correct, total, isPerfect, isLast) {
    const overlay = document.createElement("div");
    overlay.className = "stage-clear-overlay";
    const headlineMap = {
      1: "第一の碑、訳了",
      2: "第二の碑、訳了",
      3: "第三の碑、訳了",
      4: "第四の碑、訳了",
      5: "第五の碑、訳了",
    };
    const subline = isLast
      ? `第 ${stageNum} 段 完 (この島の最後の波)`
      : `第 ${stageNum} 段 完(碑 ${correct}/${total} 訳了)`;
    const perfectLine = isPerfect && total > 0
      ? `<div class="stage-clear-perfect">✦ 全問正解 + ${state.story.maxStreak} 連続 ✦</div>`
      : "";
    overlay.innerHTML = `
      <div class="stage-clear-card">
        <div class="stage-clear-rune">${runeForStage(stageNum)}</div>
        <h2 class="stage-clear-headline">${escapeHtml(headlineMap[stageNum] || `第 ${stageNum} 段 訳了`)}</h2>
        <div class="stage-clear-subline">${escapeHtml(subline)}</div>
        ${perfectLine}
      </div>
    `;
    document.body.appendChild(overlay);
    // パーティクル散らす
    for (let i = 0; i < 16; i++) {
      const p = document.createElement("div");
      p.className = "spark-particle";
      const angle = (Math.PI * 2 * i) / 16 + Math.random() * 0.3;
      const dist = 140 + Math.random() * 160;
      p.style.left = "50%"; p.style.top = "50%";
      p.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
      p.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
      p.style.animationDelay = `${Math.random() * 0.25}s`;
      overlay.appendChild(p);
    }
    setTimeout(() => overlay.remove(), 2900);
  }
  function runeForStage(n) {
    // 5段に対応する文字シンボル(神話的にあしらう)
    return ["⟁", "⟀", "⟇", "✦", "⟴"][((n - 1) % 5)] || "✦";
  }

  function abortStoryTypewriter() {
    state.story.typingAbort = true;
    if (state.story.typingTimer) {
      clearTimeout(state.story.typingTimer);
      state.story.typingTimer = null;
    }
  }
  function skipCurrentFragment() {
    // 現在の段を即時完了表示にする
    abortStoryTypewriter();
    const ch = window.DRIFTERS_DATA[state.story.chapterId];
    const frag = ch.fragments[state.story.fragIdx];
    const node = state.story._activeNode;
    if (node) {
      node.innerHTML = "";
      for (const seg of frag.segments) {
        if (seg.type === "text") {
          const span = document.createElement("span"); span.textContent = seg.text; node.appendChild(span);
        } else {
          const ws = getWordState(seg.headword);
          const chip = document.createElement("span");
          // mastered のみ static solved 表示(アニメ無し)。それ未満はスキップ後も未解扱い
          const mastered = ws.gate >= GATE_MASTERED;
          chip.className = mastered ? "story-chip solved" : "story-chip";
          chip.innerHTML = mastered
            ? `${escapeHtml(seg.headword)}<span class="chip-en">${escapeHtml(seg.jp_phrase)}</span>`
            : escapeHtml(seg.headword);
          node.appendChild(chip);
        }
      }
    }
    finishCurrentFragment(ch);
  }

  function replayChapterStory() {
    const ch = window.DRIFTERS_DATA[state.story.chapterId];
    setChapterStory(ch.id, { fragIdx: 0, started: false });
    renderStoryPanel(ch);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ===== 復習ボタン状態 =====
  function renderReviewButtons(ch) {
    // 各ゲートの出題可能数を計算
    const counts = { encounter: 0, reunion: 0, recall: 0 };
    for (const w of ch.words) {
      const s = getWordState(w.headword);
      if ((s.gate || GATE_ENCOUNTER) <= GATE_ENCOUNTER && !s.history?.some(h => h.correct)) counts.encounter += 1;
      else if (s.gate === GATE_REUNION) counts.reunion += 1;
      else if (s.gate === GATE_RECALL) counts.recall += 1;
    }
    const setBtn = (sel, n, prefix) => {
      const btn = $(sel);
      if (!btn) return;
      if (n > 0) { btn.hidden = false; btn.querySelector("span").textContent = `(${n})`; }
      else btn.hidden = true;
    };
    setBtn("#rev-encounter-btn", counts.encounter);
    setBtn("#rev-reunion-btn", counts.reunion);
    setBtn("#rev-recall-btn", counts.recall);
  }

  function renderSteleGrid(ch) {
    const host = $("#stele-grid");
    host.innerHTML = "";
    ch.words.forEach((w) => {
      const s = getWordState(w.headword);
      const chip = document.createElement("div");
      let cls = "stele-chip g" + (s.gate || 1);
      if (s.gate >= GATE_MASTERED) cls += " mastered";
      if (isRusty(w.headword)) cls += " rust";
      chip.className = cls;
      let gateLabel = "";
      if (s.gate >= GATE_MASTERED) gateLabel = `box ${s.srs_box || 1}`;
      else if (s.gate === GATE_RECALL) gateLabel = "想起";
      else if (s.gate === GATE_REUNION) gateLabel = "再会";
      else gateLabel = "遭遇";
      chip.innerHTML = `
        <div class="sc-head">${w.headword}</div>
        <div class="sc-gate">${gateLabel}</div>
      `;
      chip.addEventListener("click", () => startQuizForWord(w.headword));
      host.appendChild(chip);
    });
  }

  // ========== Build queue ==========
  function buildQueueIncomplete(chapter) {
    const queue = [];
    for (const w of chapter.words) {
      if (!isMastered(w.headword)) queue.push({ word: w, mode: "advance" });
    }
    return shuffle(queue);
  }
  function buildQueueRust(chapter) {
    const queue = [];
    for (const w of chapter.words) {
      if (isRusty(w.headword)) queue.push({ word: w, mode: "rust" });
    }
    return shuffle(queue);
  }
  function buildQueueAllRust() {
    const queue = [];
    for (const meta of window.DRIFTERS_MANIFEST.chapters) {
      const ch = window.DRIFTERS_DATA[meta.id];
      if (!ch) continue;
      for (const w of ch.words) {
        if (isRusty(w.headword)) queue.push({ word: w, mode: "rust", chapterId: meta.id });
      }
    }
    return shuffle(queue);
  }

  function startQuizForWord(headword) {
    const ch = window.DRIFTERS_DATA[state.currentChapterId];
    const w = ch.words.find(x => x.headword === headword);
    state.queue = [{ word: w, mode: isMastered(headword) ? "rust" : "advance" }];
    startQueue();
  }
  function startChapterIncomplete() {
    const ch = window.DRIFTERS_DATA[state.currentChapterId];
    state.queue = buildQueueIncomplete(ch);
    if (state.queue.length === 0) {
      toast("この章はすべて mastered 済み");
      return;
    }
    startQueue();
  }

  function startChapterByGate(gate) {
    const ch = window.DRIFTERS_DATA[state.currentChapterId];
    const queue = [];
    for (const w of ch.words) {
      const s = getWordState(w.headword);
      const currentGate = s.gate || GATE_ENCOUNTER;
      if (gate === GATE_ENCOUNTER) {
        if (currentGate <= GATE_ENCOUNTER) queue.push({ word: w, mode: "advance" });
      } else if (gate === GATE_REUNION) {
        if (currentGate === GATE_REUNION) queue.push({ word: w, mode: "advance" });
      } else if (gate === GATE_RECALL) {
        if (currentGate === GATE_RECALL) queue.push({ word: w, mode: "advance" });
      }
    }
    if (queue.length === 0) {
      toast("出題できる碑がない");
      return;
    }
    state.queue = shuffle(queue);
    startQueue();
  }
  function startChapterRust() {
    const ch = window.DRIFTERS_DATA[state.currentChapterId];
    state.queue = buildQueueRust(ch);
    if (state.queue.length === 0) {
      toast("磨き直しが必要な碑はない");
      return;
    }
    startQueue();
  }
  function startAllRust() {
    state.queue = buildQueueAllRust();
    if (state.queue.length === 0) {
      toast("全島で磨き直しが必要な碑はない");
      return;
    }
    startQueue();
  }
  function startQueue() {
    state.queueIndex = 0;
    state.sessionWords = new Set();
    state.sessionCorrect = 0;
    state.sessionTotal = 0;
    state.sessionStartTs = Date.now();
    showScreen("stele");
    renderCurrent();
  }

  // ========== Render current problem ==========
  function renderCurrent() {
    const item = state.queue[state.queueIndex];
    if (!item) return finishSession();
    const { word, mode } = item;
    const s = getWordState(word.headword);

    // 出題ゲート決定: advance なら 現在の gate、rust なら reunion(再出題で2段目)
    const targetGate = mode === "rust" ? GATE_REUNION : Math.min(GATE_RECALL, s.gate || GATE_ENCOUNTER);
    item._activeGate = targetGate;

    const meta = window.DRIFTERS_MANIFEST.chapters.find(m => m.id === (state.currentChapterId || item.chapterId));
    $("#stele-island-tag").textContent = meta ? `Ch.${meta.index} ${meta.island_name}` : "";
    const pct = (state.queueIndex / state.queue.length) * 100;
    $("#progress-bar").style.setProperty("--progress", `${pct}%`);
    $("#progress-text").textContent = `${state.queueIndex + 1} / ${state.queue.length}`;

    // ゲートタグ
    const gateTag = $("#qgate");
    gateTag.className = "qgate";
    if (mode === "rust") { gateTag.classList.add("g-rust"); gateTag.textContent = "磨き直し"; }
    else if (targetGate === GATE_ENCOUNTER) { gateTag.classList.add("g-encounter"); gateTag.textContent = "遭遇 1/3"; }
    else if (targetGate === GATE_REUNION) { gateTag.classList.add("g-reunion"); gateTag.textContent = "再会 2/3"; }
    else if (targetGate === GATE_RECALL) { gateTag.classList.add("g-recall"); gateTag.textContent = "想起 3/3"; }

    $("#qhead").textContent = word.headword;
    $("#qpos").textContent = word.pos;

    // 各ゲートを隠す
    $("#gate-encounter").classList.add("hidden");
    $("#gate-reunion").classList.add("hidden");
    $("#gate-recall").classList.add("hidden");
    $("#answer-reveal").classList.add("hidden");
    $("#check-btn").classList.remove("hidden");
    $("#skip-btn").classList.remove("hidden");
    state.chosenIndex = null;

    if (targetGate === GATE_ENCOUNTER) {
      $("#qprompt").textContent = "この語の意味として最も適切なものは?";
      renderChoices(word);
      $("#gate-encounter").classList.remove("hidden");
    } else if (targetGate === GATE_REUNION || mode === "rust") {
      $("#qprompt").textContent = "この意味になる英単語をタイピング";
      $("#meaning-display").textContent = word.jp_meaning;
      $("#reunion-input").value = "";
      $("#reunion-input").disabled = false;
      $("#gate-reunion").classList.remove("hidden");
      setTimeout(()=> $("#reunion-input").focus(), 80);
    } else if (targetGate === GATE_RECALL) {
      $("#qprompt").textContent = "現代の例文の空欄を埋めてください";
      $("#recall-sentence").innerHTML = blankoutSentence(word.modern_en, word.headword);
      $("#recall-sentence-jp").textContent = word.modern_jp;
      $("#recall-input").value = "";
      $("#recall-input").disabled = false;
      $("#gate-recall").classList.remove("hidden");
      setTimeout(()=> $("#recall-input").focus(), 80);
    }

    renderRecordControls(word.headword);
  }

  function blankoutSentence(sentence, headword) {
    if (!sentence) return "(例文なし)";
    // headword と簡易な派生形をマスク
    const stems = expandStems(headword);
    const re = new RegExp(`\\b(${stems.join("|")})\\b`, "i");
    return escapeHtml(sentence).replace(re, "_____");
  }
  function expandStems(headword) {
    const base = headword.toLowerCase();
    const list = [base];
    if (base.endsWith("e")) {
      list.push(base + "s", base + "d", base.slice(0,-1) + "ing");
    } else if (base.endsWith("y")) {
      list.push(base.slice(0,-1) + "ies", base.slice(0,-1) + "ied", base + "ing");
    } else {
      list.push(base + "s", base + "es", base + "ed", base + "ing");
    }
    return [...new Set(list)].map(escapeRegex);
  }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function renderChoices(word) {
    // 4択: 正答 + 同章 or 他章から3つランダム
    const distractors = pickDistractors(word, 3);
    const choices = shuffle([
      { label: word.jp_meaning.split(";")[0].trim(), correct: true },
      ...distractors.map(d => ({ label: d.jp_meaning.split(";")[0].trim(), correct: false })),
    ]);
    const host = $("#choice-list");
    host.innerHTML = "";
    const keys = ["1","2","3","4"];
    choices.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "choice-btn"; btn.dataset.index = i; btn.dataset.correct = c.correct ? "1" : "0";
      btn.innerHTML = `<span class="choice-key">${keys[i]}</span><span>${escapeHtml(c.label)}</span>`;
      btn.addEventListener("click", () => selectChoice(i));
      host.appendChild(btn);
    });
  }
  function selectChoice(i) {
    state.chosenIndex = i;
    $$(".choice-btn").forEach(b => b.classList.toggle("selected", Number(b.dataset.index) === i));
  }
  function pickDistractors(word, n) {
    const pool = [];
    for (const meta of window.DRIFTERS_MANIFEST.chapters) {
      const ch = window.DRIFTERS_DATA[meta.id];
      if (!ch) continue;
      for (const w of ch.words) {
        if (w.headword !== word.headword) pool.push(w);
      }
    }
    const ownPrimary = word.jp_meaning.split(";")[0].trim();
    const candidates = pool.filter(w => w.jp_meaning.split(";")[0].trim() !== ownPrimary);
    return shuffle(candidates).slice(0, n);
  }

  // ========== Grading ==========
  function grade() {
    const item = state.queue[state.queueIndex];
    const { word, mode } = item;
    const activeGate = item._activeGate;
    let correct = false;

    if (activeGate === GATE_ENCOUNTER) {
      if (state.chosenIndex == null) { toast("選択肢を選んでください"); return; }
      const btn = document.querySelector(`.choice-btn[data-index="${state.chosenIndex}"]`);
      correct = btn && btn.dataset.correct === "1";
      $$(".choice-btn").forEach(b => {
        if (b.dataset.correct === "1") b.classList.add("correct");
        else if (Number(b.dataset.index) === state.chosenIndex) b.classList.add("wrong");
      });
    } else if (activeGate === GATE_REUNION || mode === "rust") {
      const ans = $("#reunion-input").value.trim().toLowerCase();
      if (!ans) { toast("入力してください"); return; }
      const stems = expandStems(word.headword);
      correct = stems.includes(ans);
      $("#reunion-input").disabled = true;
    } else if (activeGate === GATE_RECALL) {
      const ans = $("#recall-input").value.trim().toLowerCase();
      if (!ans) { toast("入力してください"); return; }
      const stems = expandStems(word.headword);
      correct = stems.includes(ans);
      $("#recall-input").disabled = true;
    }

    recordOutcome(word.headword, activeGate, correct);
    state.sessionWords.add(word.headword);
    state.sessionTotal += 1;
    if (correct) state.sessionCorrect += 1;

    // 採点開示
    $("#answer-reveal").classList.remove("hidden");
    const judge = $("#judge-result");
    const newState = getWordState(word.headword);
    if (correct && newState.gate >= GATE_MASTERED && newState.srs_box === 1) {
      judge.textContent = "✓✓✓ 碑が完全に訳された — mastered";
      judge.className = "mastered";
    } else if (correct) {
      const next = newState.gate >= GATE_MASTERED ? "次の磨き直しまで保存" : `次は ${gateLabel(newState.gate)}`;
      judge.textContent = `✓ 正解 — ${next}`;
      judge.className = "correct";
    } else {
      judge.textContent = "✗ もう一度";
      judge.className = "incorrect";
    }

    $("#reveal-stele").innerHTML = `${escapeHtml(word.stele_en)}<span class="stele-jp">${escapeHtml(word.stele_jp)}</span>`;
    $("#reveal-modern").innerHTML = `<span class="modern-en">${escapeHtml(word.modern_en)}</span><span class="modern-jp">${escapeHtml(word.modern_jp)}</span>`;

    $("#check-btn").classList.add("hidden");
    $("#skip-btn").classList.add("hidden");
    renderHeaderStats();
  }

  function gateLabel(g) {
    if (g === GATE_REUNION) return "再会(タイピング)";
    if (g === GATE_RECALL) return "想起(例文穴埋め)";
    if (g >= GATE_MASTERED) return "mastered";
    return "遭遇(4択)";
  }

  function nextQuestion() {
    state.queueIndex += 1;
    renderCurrent();
  }
  function skipQuestion() {
    const item = state.queue[state.queueIndex];
    recordOutcome(item.word.headword, item._activeGate || GATE_ENCOUNTER, false);
    state.queueIndex += 1;
    renderCurrent();
  }

  // ========== Session finish ==========
  function finishSession() {
    // セッションログ
    const log = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
    log.push({
      ts: Date.now(),
      chapterId: state.currentChapterId,
      total: state.sessionTotal,
      correct: state.sessionCorrect,
      words: Array.from(state.sessionWords),
    });
    localStorage.setItem(SESSION_KEY, JSON.stringify(log.slice(-60)));

    // 章が 100% mastered になったか?
    if (state.currentChapterId) {
      const ch = window.DRIFTERS_DATA[state.currentChapterId];
      const prog = chapterProgress(ch);
      if (prog.percent >= 100) {
        showVoyageOut(ch);
        return;
      }
    }
    // ふつうのセッション終了は landing に戻る
    if (state.currentChapterId) {
      openChapter(state.currentChapterId);
    } else {
      showScreen("atlas");
      renderAtlas(); renderChapterGrid();
    }
  }

  function showVoyageOut(ch) {
    const meta = window.DRIFTERS_MANIFEST.chapters.find(m => m.id === ch.id);
    $("#voyage-island").textContent = meta.island_name;
    const finalFrag = ch.fragments[ch.fragments.length - 1];
    $("#voyage-fragment-final").innerHTML = escapeHtml(finalFrag.text).replace(/\n/g, "<br>");
    showScreen("voyage");

    // 全16章クリアか確認
    const allDone = window.DRIFTERS_MANIFEST.chapters.every(m => {
      const c = window.DRIFTERS_DATA[m.id];
      return c && chapterProgress(c).percent >= 100;
    });
    if (allDone) {
      $("#voyage-actions button[data-action='voyage-out']")?.setAttribute("data-final","1");
    }
  }

  function voyageOut() {
    // 全16章クリア確認
    const allDone = window.DRIFTERS_MANIFEST.chapters.every(m => {
      const c = window.DRIFTERS_DATA[m.id];
      return c && chapterProgress(c).percent >= 100;
    });
    if (allDone) {
      // エピローグへ
      showEpilogue();
    } else {
      showScreen("atlas");
      renderAtlas(); renderChapterGrid();
    }
  }
  function showEpilogue() {
    $("#epilogue-text").innerHTML = `
      漂流者は灯台の頂上に立った。<br>
      訳された言葉が、世界全土の島々を照らしていた。<br>
      <br>
      最後の言葉は、口に出さなかった——<br>
      その必要が、もはやなかったから。<br>
      <br>
      しかし、誰かが次の漂流者になるとき、<br>
      この灯台はまた光るだろう。<br>
      <br>
      <em>— Fin / The Drifter's Codex —</em>
    `;
    showScreen("epilogue");
  }

  // ========== Journal copy ==========
  async function copyJournal() {
    const log = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
    const today = todayStr();
    const todayWords = new Set();
    for (const s of log) {
      const d = new Date(s.ts);
      const dStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      if (dStr === today) s.words.forEach(w => todayWords.add(w));
    }
    state.sessionWords.forEach(w => todayWords.add(w));
    if (todayWords.size === 0) {
      toast("今日まだ単語に触れていません");
      return;
    }
    const lines = [];
    for (const head of Array.from(todayWords).slice(0, 12)) {
      for (const meta of window.DRIFTERS_MANIFEST.chapters) {
        const ch = window.DRIFTERS_DATA[meta.id];
        if (!ch) continue;
        const w = ch.words.find(x => x.headword === head);
        if (w) {
          lines.push(`- ${w.headword} (${w.jp_meaning}) — 碑: "${w.stele_en}" / 現代例: "${w.modern_en}"`);
          break;
        }
      }
    }
    const prompt = [
      "以下は今日「The Drifter's Codex」で訳した単語です。これらを使った英語短文(Tweet形式・280字以内)を3案ほど書いて。",
      "「INTPの深淵」チャンネル文脈で、皮肉・観察・問いかけのいずれかのトーン。",
      "提案後、私の英文を待ち受けて添削モードに入ってください。",
      "",
      "今日の訳了語:",
      ...lines,
      "",
      "なお碑文(古文体)は装飾的引用、現代例は文法参考としてのみ参照ください。",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(prompt);
      toast("クリップボードにコピー。Claude セッションに貼り付けてください。");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = prompt; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      toast("コピー完了 (フォールバック)");
    }
  }

  // ========== Recording ==========
  let mediaRecorder = null, recordingChunks = [], recordingFor = null;

  function renderRecordControls(headword) {
    recordingFor = headword;
    const btn = $("#record-btn");
    btn.classList.remove("recording"); btn.textContent = "● 録音開始";
    $("#record-status").textContent = "";
    $("#record-play-btn").classList.add("hidden");
    $("#record-yesterday-btn").classList.add("hidden");
    const recs = loadRecordings();
    const yesterday = findYesterdayRecording(recs, headword);
    if (yesterday) {
      const b = $("#record-yesterday-btn"); b.classList.remove("hidden");
      b.onclick = () => playRecording(yesterday.dataUrl);
    }
    const today = (recs[headword] || []).filter(r => isSameLocalDay(r.ts, Date.now())).slice(-1)[0];
    if (today) {
      const b = $("#record-play-btn"); b.classList.remove("hidden");
      b.onclick = () => playRecording(today.dataUrl);
    }
  }
  function loadRecordings() { try { return JSON.parse(localStorage.getItem(RECORDING_KEY) || "{}"); } catch { return {}; } }
  function saveRecording(head, dataUrl) {
    const recs = loadRecordings();
    const arr = recs[head] || [];
    arr.push({ ts: Date.now(), dataUrl });
    recs[head] = arr.slice(-5);
    try { localStorage.setItem(RECORDING_KEY, JSON.stringify(recs)); }
    catch {
      // 容量不足: 全 head の最古を捨てる
      for (const k of Object.keys(recs)) recs[k] = (recs[k] || []).slice(-1);
      localStorage.setItem(RECORDING_KEY, JSON.stringify(recs));
      toast("ストレージ容量を整理しました");
    }
  }
  function isSameLocalDay(t1, t2) {
    const a = new Date(t1), b = new Date(t2);
    return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  }
  function findYesterdayRecording(recs, head) {
    const arr = recs[head] || [];
    const now = Date.now();
    const c = arr.filter(r => { const d = now - r.ts; return d > 12*3600*1000 && d < 48*3600*1000; });
    return c[c.length - 1] || null;
  }
  function playRecording(dataUrl) { new Audio(dataUrl).play().catch(e => toast("再生不可: " + e.message)); }
  async function toggleRecord() {
    const btn = $("#record-btn");
    if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => recordingChunks.push(e.data);
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        const dataUrl = await blobToDataUrl(blob);
        saveRecording(recordingFor, dataUrl);
        $("#record-status").textContent = `保存しました (${Math.round(blob.size/1024)} KB)`;
        btn.classList.remove("recording"); btn.textContent = "● 録音開始";
        const b = $("#record-play-btn"); b.classList.remove("hidden");
        b.onclick = () => playRecording(dataUrl);
      };
      mediaRecorder.start();
      btn.classList.add("recording"); btn.textContent = "■ 録音停止";
      $("#record-status").textContent = "録音中…";
    } catch (e) { toast("マイク権限拒否: " + e.message); }
  }
  function blobToDataUrl(b) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  }

  // ========== Utilities ==========
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }
  function toast(msg) {
    const host = $("#toast-host");
    const el = document.createElement("div"); el.className = "toast"; el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ========== Events ==========
  function bindEvents() {
    document.body.addEventListener("click", (e) => {
      const a = e.target.closest("[data-action]")?.dataset.action;
      if (!a) return;
      switch (a) {
        case "back-to-atlas": abortStoryTypewriter(); showScreen("atlas"); renderAtlas(); renderChapterGrid(); break;
        case "back-to-landing": openChapter(state.currentChapterId); break;
        case "start-encounter": startChapterByGate(GATE_ENCOUNTER); break;
        case "start-reunion": startChapterByGate(GATE_REUNION); break;
        case "start-recall": startChapterByGate(GATE_RECALL); break;
        case "start-rust": startChapterRust(); break;
        case "resume-rust": startAllRust(); break;
        case "copy-journal": copyJournal(); break;
        case "voyage-out": voyageOut(); break;
      }
    });

    // 物語タイプライターのボタン
    $("#story-start-btn").addEventListener("click", () => { startStoryTypewriter(); });
    $("#story-next-frag-btn").addEventListener("click", () => {
      $("#story-next-frag-btn").hidden = true;
      const ch = window.DRIFTERS_DATA[state.story.chapterId];
      // 次の段の active node を準備
      const stage = $("#story-stage");
      // 前の段は静的化(現在の状態を維持)
      const oldActive = state.story._activeNode;
      if (oldActive) oldActive.classList.add("dim");
      const current = document.createElement("div");
      current.className = "fragment-active";
      current.style.marginTop = "14px";
      stage.appendChild(current);
      state.story._activeNode = current;
      startStoryTypewriter();
    });
    $("#story-skip-btn").addEventListener("click", () => {
      // タイプライタースキップ: 現在の段を即時最後まで表示(interactiveも自動スキップ)
      // 安全策として、未終了 interactive のモーダルが開いていれば閉じる
      const modal = $("#inline-modal");
      if (!modal.classList.contains("hidden")) modal.classList.add("hidden");
      skipCurrentFragment();
    });
    $("#story-replay-btn").addEventListener("click", replayChapterStory);
    $("#check-btn").addEventListener("click", grade);
    $("#skip-btn").addEventListener("click", skipQuestion);
    $("#next-btn").addEventListener("click", nextQuestion);
    $("#record-btn").addEventListener("click", toggleRecord);

    document.addEventListener("keydown", (e) => {
      if (!screens.stele.classList.contains("active")) return;
      const tag = document.activeElement?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Enter") {
        if ($("#answer-reveal").classList.contains("hidden")) grade();
        else nextQuestion();
        e.preventDefault();
      } else if (!inInput && ["1","2","3","4"].includes(e.key)) {
        const idx = "1234".indexOf(e.key);
        const btn = document.querySelector(`.choice-btn[data-index="${idx}"]`);
        if (btn) selectChoice(idx);
      }
    });
  }

  // ========== Boot ==========
  function boot() {
    if (!window.DRIFTERS_MANIFEST || !window.DRIFTERS_DATA) {
      document.body.innerHTML = "<h1 style='padding:40px;color:#d96b71'>データ未生成。<code>python3 automation/11_build_drifters_data.py</code> を先に実行。</h1>";
      return;
    }
    bumpStreak();
    renderHeaderStats();
    renderAtlas();
    renderChapterGrid();
    bindEvents();
    // 起動時の磨き直し通知
    const o = overallProgress();
    if (o.rusty > 0) toast(`⌛ 磨き直しが必要な碑が ${o.rusty} 個あります`);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
