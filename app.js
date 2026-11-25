(() => {
  const $ = (s) => document.querySelector(s);
  const input = $('#in'), out = $('#out'), count = $('#count'), clear = $('#clear');
  const copyBtn = $('#copy'), sendBtn = $('#send');
  const MAX = 300;
  let engine = null;
  let shown = '';   // 결과 칸에 보이는 글
  let usagi = '';   // 보낼 우사기 말

  const loading = fetch('model/korean.bin')
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then((b) => { engine = UsagiEngine.load(b); });

  function tr(raw) {
    const text = raw.trim();
    if (!text || !engine) return null;
    if (engine.isUsagi(text)) {
      const r = engine.decodeDetailed(text);
      if (r.unknown.length) return { dir: 'decode', err: '모르는 우사기 단어가 있어요: ' + r.unknown.slice(0, 3).join(', ') };
      return { dir: 'decode', out: r.text };
    }
    return { dir: 'encode', out: engine.encode(text) };
  }

  // 단어 중간이나 '~' 앞에서 줄이 끊기지 않게 단어 단위로 묶는다
  function words(el, text) {
    el.textContent = '';
    let i = 0;
    text.split(/(\s+)/).forEach((w) => {
      if (/^\s+$/.test(w)) return el.append(w);
      const s = document.createElement('span');
      s.className = 'w'; s.textContent = w;
      s.style.setProperty('--i', Math.min(i++, 14));
      el.append(s);
    });
  }

  // 타이핑이 멈추면 귀가 쫑긋, 단어가 폴짝
  const ears = $('#ears'), ema = $('.ema');
  let hopT;
  function perk() {
    ears.classList.remove('perk'); ema.classList.remove('on');
    void ears.getBoundingClientRect();
    ears.classList.add('perk'); ema.classList.add('on');
  }
  function hop() {
    clearTimeout(hopT);
    hopT = setTimeout(() => {
      out.classList.remove('hop'); void out.offsetWidth; out.classList.add('hop');
      perk();
    }, 380);
  }
  const SHOUT = ['우라!', '하아?', '야하!', '프루루루…', '이얏하!'];
  ears.addEventListener('click', () => { perk(); toast(SHOUT[Math.floor(Math.random() * SHOUT.length)]); });

  function setOut(text, cls) {
    out.className = 'usagi ' + cls;
    words(out, text);
    void out.offsetWidth;
    out.classList.add('fresh');
  }

  function update() {
    const len = [...input.value].length;
    count.textContent = len + ' / ' + MAX;
    clear.hidden = !len;
    const r = tr(input.value);
    const ok = !!(r && !r.err);
    copyBtn.disabled = sendBtn.disabled = !ok;
    const decode = r?.dir === 'decode';
    $('#srcLab').textContent = decode ? '우사기' : '한국어';
    $('#outLab').textContent = decode ? '한국어' : '우사기';
    if (!r) { shown = usagi = ''; return setOut(engine ? '…' : '불러오는 중…', 'empty'); }
    if (r.err) { shown = usagi = ''; return setOut(r.err, 'err'); }
    shown = r.out;
    usagi = decode ? input.value.trim() : r.out;
    setOut(r.out, decode ? 'ko' : '');
    if (!decode) hop();
  }

  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(update, 90); });
  clear.addEventListener('click', () => { input.value = ''; update(); input.focus(); });

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('on'), 1500);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
  }

  // 링크의 # 뒤는 서버로 가지 않는다. 받은 사람이 열면 바로 풀 수 있다.
  const linkFor = (u) => location.origin + location.pathname + '#' + encodeURIComponent(u);

  copyBtn.addEventListener('click', () => copy(shown).then(() => toast('복사했어요')));
  sendBtn.addEventListener('click', async () => {
    const url = linkFor(usagi);
    if (navigator.share) {
      try { await navigator.share({ text: usagi, url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    await copy(usagi + '\n' + url);
    toast('링크를 복사했어요');
  });

  function received() {
    try { return decodeURIComponent(location.hash.slice(1)).trim(); } catch { return ''; }
  }

  update();
  loading.then(() => {
    const got = received();
    const r = got ? tr(got) : null;
    if (r && r.dir === 'decode' && !r.err) {
      $('#got').hidden = false;
      words($('#gotText'), got);
      input.placeholder = '한국어나 우사기어 입력';
      $('#reveal').addEventListener('click', (e) => {
        e.currentTarget.remove();
        const p = $('#gotText');
        p.textContent = r.out;
        p.classList.add('ko');
        input.focus({ preventScroll: true });
      }, { once: true });
    } else {
      input.placeholder = '한국어나 우사기어 입력';
    }
    update();
  }).catch(() => setOut('번역기를 불러오지 못했어요. 새로고침해 주세요.', 'err'));
})();
