//! NontonAnimeID scraper — Rust port (100% feature parity with nontonanime.ts).
//! Build: cargo build --release | Run: ./target/release/nontonanime search "one piece"

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use regex::Regex;
use reqwest::{redirect::Policy, Client, Method};
use scraper::{Html, Selector};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// === CONFIG ===
fn base() -> String {
    let b = std::env::var("ANIME_BASE").unwrap_or_else(|_| "https://s13.nontonanimeid.boats".into());
    b.trim_end_matches('/').to_string()
}
fn base_host() -> String {
    static H: OnceLock<String> = OnceLock::new();
    H.get_or_init(|| host_of(&base()).to_lowercase()).clone()
}
fn host_of(raw: &str) -> String {
    reqwest::Url::parse(raw).map(|u| u.host_str().unwrap_or("").to_string()).unwrap_or_default()
}

const TIMEOUT_MS: u64 = 15_000;
const MAX_BYTES: usize = 3_000_000;
const MAX_REDIRECTS: u32 = 5;
const MAX_RETRIES: u32 = 3;
const MIN_INTERVAL_MS: u64 = 350;
const CACHE_TTL: Duration = Duration::from_secs(300);
const CACHE_MAX: usize = 100;

fn headers() -> Vec<(&'static str, String)> {
    vec![
        ("user-agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36".into()),
        ("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8".into()),
        ("accept-language", "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7".into()),
        ("referer", format!("{}/", base())),
        ("dnt", "1".into()),
        ("sec-ch-ua", "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"".into()),
        ("sec-ch-ua-mobile", "?1".into()),
        ("sec-ch-ua-platform", "\"Android\"".into()),
        ("sec-fetch-dest", "document".into()),
        ("sec-fetch-mode", "navigate".into()),
        ("sec-fetch-site", "same-origin".into()),
        ("sec-fetch-user", "?1".into()),
        ("upgrade-insecure-requests", "1".into()),
    ]
}

fn client() -> Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        // load system roots (rustls-tls-manual-roots ships empty store)
        let mut roots = rustls::RootCertStore::empty();
        let pem = std::fs::read("/etc/ssl/certs/ca-certificates.crt").unwrap_or_default();
        let mut rd = std::io::BufReader::new(&pem[..]);
        if let Ok(certs) = rustls_pemfile::certs(&mut rd) {
            for cert in certs {
                let _ = roots.add(&rustls::Certificate(cert));
            }
        }
        let tls = rustls::ClientConfig::builder()
            .with_safe_defaults()
            .with_root_certificates(roots)
            .with_no_client_auth();
        Client::builder()
            .timeout(Duration::from_millis(TIMEOUT_MS))
            .redirect(Policy::none())
            .gzip(true)
            .brotli(true)
            .use_preconfigured_tls(tls)
            .build()
            .expect("client")
    })
    .clone()
}

// === SSRF / URL GUARDS ===
fn blocked_host_re() -> Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)^(localhost|127\.|0\.0\.0\.0|\[::|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)").unwrap()
    })
    .clone()
}
fn is_blocked_host(host: &str) -> bool {
    let h = host.to_lowercase().trim_matches(|c| c == '[' || c == ']').to_string();
    blocked_host_re().is_match(&h) || h == "localhost" || h == "::1"
}
fn parse_url(s: &str) -> Option<reqwest::Url> {
    let full = if s.starts_with('/') { format!("{}{}", base(), s) } else { s.to_string() };
    reqwest::Url::parse(&full).ok()
}
fn is_valid_url(s: &str) -> bool {
    if s.is_empty() || s.len() > 2048 {
        return false;
    }
    let u = match parse_url(s) {
        Some(u) => u,
        None => return false,
    };
    if u.scheme() != "https" && u.scheme() != "http" {
        return false;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    if is_blocked_host(u.host_str().unwrap_or("")) {
        return false;
    }
    true
}
fn assert_site_url(raw: &str) -> Result<String, String> {
    let u = parse_url(raw).ok_or_else(|| "Invalid URL".to_string())?;
    if (u.scheme() != "https" && u.scheme() != "http")
        || u.host_str().unwrap_or("").to_lowercase() != base_host()
    {
        return Err(format!("URL host not allowed: {}", u.host_str().unwrap_or("")));
    }
    if is_blocked_host(u.host_str().unwrap_or("")) {
        return Err("Blocked host".into());
    }
    Ok(u.to_string())
}
fn sanitize_url(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Empty URL".into());
    }
    let mut clean = path.trim().to_string();
    if clean.len() > 2048 {
        clean.truncate(2048);
    }
    if clean.chars().any(|c| c.is_control() || c == '\\') {
        return Err("Illegal chars in URL".into());
    }
    let l = clean.to_lowercase();
    if l.starts_with("javascript:") || l.starts_with("data:") || l.starts_with("vbscript:") {
        return Err("Blocked URL scheme".into());
    }
    let b = reqwest::Url::parse(&format!("{}/", base())).map_err(|e| e.to_string())?;
    let u = b.join(&clean).map_err(|e| e.to_string())?;
    if u.host_str().unwrap_or("").to_lowercase() != base_host() {
        return Err(format!("External host rejected: {}", u.host_str().unwrap_or("")));
    }
    let mut u = u;
    let _ = u.set_username("");
    let _ = u.set_password(None);
    u.set_fragment(None);
    Ok(u.to_string())
}
fn resolve_url(raw: &str, b: &str) -> Result<String, String> {
    let bb = reqwest::Url::parse(b).map_err(|e| e.to_string())?;
    let u = bb.join(raw).map_err(|e| e.to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err("Bad redirect scheme".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("Creds in URL blocked".into());
    }
    if is_blocked_host(u.host_str().unwrap_or("")) {
        return Err("Blocked redirect host".into());
    }
    let s = u.to_string();
    if s.len() > 2048 {
        return Err("URL too long".into());
    }
    Ok(s)
}

// === RATE LIMITER (serial + jitter) ===
struct Limiter {
    token: tokio::sync::Mutex<()>,
    last: Mutex<Instant>,
}
impl Limiter {
    fn global() -> &'static Limiter {
        static L: OnceLock<Limiter> = OnceLock::new();
        L.get_or_init(|| Limiter {
            token: tokio::sync::Mutex::new(()),
            last: Mutex::new(Instant::now() - Duration::from_secs(60)),
        })
    }
    async fn run<F, Fut>(&self, f: F) -> Result<String, String>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<String, String>>,
    {
        let _g = self.token.lock().await;
        let wait = {
            let last = *self.last.lock().unwrap();
            MIN_INTERVAL_MS.saturating_sub(last.elapsed().as_millis() as u64)
        };
        if wait > 0 {
            let jitter: u64 = rand_ms(120);
            tokio::time::sleep(Duration::from_millis(wait + jitter)).await;
        }
        let out = f().await;
        *self.last.lock().unwrap() = Instant::now();
        out
    }
}
fn rand_ms(n: u64) -> u64 {
    // xorshift64* — no extra deps for jitter
    use std::cell::Cell;
    thread_local! { static S: Cell<u64> = Cell::new(0x9E3779B97F4A7C15); }
    S.with(|s| {
        let mut x = s.get();
        if x == 0 {
            x = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(1);
        }
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        s.set(x);
        x.wrapping_mul(0x2545F4914F6CDD1D) % (n + 1)
    })
}

// === CACHE (LRU + in-flight dedupe) ===
struct Cache {
    map: HashMap<String, (Instant, String)>,
    ord: VecDeque<String>,
}
struct Slot {
    notify: tokio::sync::Notify,
    result: Mutex<Option<Result<String, String>>>,
}
struct State {
    cache: Mutex<Cache>,
    inflight: Mutex<HashMap<String, std::sync::Arc<Slot>>>,
}
impl State {
    fn global() -> &'static State {
        static S: OnceLock<State> = OnceLock::new();
        S.get_or_init(|| State {
            cache: Mutex::new(Cache { map: HashMap::new(), ord: VecDeque::new() }),
            inflight: Mutex::new(HashMap::new()),
        })
    }
}
fn cache_get(k: &str) -> Option<String> {
    let mut c = State::global().cache.lock().unwrap();
    let (t, v) = c.map.get(k)?.clone();
    if t.elapsed() > CACHE_TTL {
        c.map.remove(k);
        c.ord.retain(|x| x != k);
        return None;
    }
    c.ord.retain(|x| x != k);
    c.ord.push_back(k.to_string());
    Some(v)
}
fn cache_set(k: &str, v: String) {
    let mut c = State::global().cache.lock().unwrap();
    c.map.insert(k.to_string(), (Instant::now(), v));
    c.ord.retain(|x| x != k);
    c.ord.push_back(k.to_string());
    while c.ord.len() > CACHE_MAX {
        if let Some(old) = c.ord.pop_front() {
            c.map.remove(&old);
        }
    }
}

// === CORE FETCH ===
fn is_retryable_net(msg: &str) -> bool {
    let m = msg.to_lowercase();
    ["timeout", "econn", "enotfound", "eai_again", "socket", "connection", "reset", "refused", "deadline", "timed out"]
        .iter()
        .any(|k| m.contains(k))
}
fn waf_re() -> Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)attention required|just a moment|cf-challenge|captcha|you have been blocked").unwrap()).clone()
}
async fn read_capped(res: reqwest::Response) -> Result<String, String> {
    if let Some(cl) = res.headers().get("content-length") {
        if let Ok(s) = cl.to_str() {
            if let Ok(n) = s.trim().parse::<i64>() {
                if n > MAX_BYTES as i64 {
                    return Err(format!("Body too large ({n} bytes)"));
                }
            }
        }
    }
    if let Some(ct) = res.headers().get("content-type") {
        if let Ok(s) = ct.to_str() {
            let l = s.to_lowercase();
            if l.contains("image/") || l.contains("video/") || l.contains("octet-stream") {
                return Err(format!("Unexpected content-type: {s}"));
            }
        }
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Body exceeds 3MB cap".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())
}
async fn do_fetch(url: &str, post: Option<String>, extra: Vec<(String, String)>) -> Result<String, String> {
    let mut cur = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        let mut rb = match &post {
            Some(b) => client().request(Method::POST, cur.clone()).body(b.clone()),
            None => client().get(cur.clone()),
        };
        for (k, v) in headers() {
            rb = rb.header(k, v);
        }
        for (k, v) in &extra {
            rb = rb.header(k.as_str(), v.as_str());
        }
        let res = rb.send().await.map_err(|e| {
            let m = e.to_string();
            if is_retryable_net(&m) {
                format!("RETRYABLE {m}")
            } else {
                m
            }
        })?;
        let status = res.status().as_u16();
        if (300..400).contains(&status) {
            let loc = res.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            if loc.is_empty() {
                return Err(format!("Redirect {status} without location"));
            }
            cur = resolve_url(&loc, &cur)?;
            continue;
        }
        if status == 429 || (500..600).contains(&status) {
            let mut backoff: Option<u64> = None;
            if let Some(v) = res.headers().get("retry-after") {
                if let Ok(s) = v.to_str() {
                    if let Ok(n) = s.trim().parse::<u64>() {
                        backoff = Some(n * 1000);
                    }
                }
            }
            let b = backoff.map(|n| format!(" RA:{n}")).unwrap_or_default();
            return Err(format!("RETRYABLE HTTP {status} for {cur}{b}"));
        }
        if status == 403 || status == 401 || status == 503 {
            let body = read_capped(res).await.unwrap_or_default();
            if waf_re().is_match(&body) {
                return Err(format!("WAF blocked (Cloudflare) for {cur} — filter params trip bot protection; retry with fewer filters"));
            }
            return Err(format!("HTTP {status} for {cur}"));
        }
        if status != 200 {
            return Err(format!("HTTP {status} for {cur}"));
        }
        return read_capped(res).await;
    }
    Err("Too many redirects".into())
}
async fn with_retry(url: &str, post: Option<String>, extra: Vec<(String, String)>) -> Result<String, String> {
    let mut last = "failed".to_string();
    for i in 0..=MAX_RETRIES {
        match do_fetch(url, post.clone(), extra.clone()).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e.clone();
                let retryable = last.starts_with("RETRYABLE ");
                if !retryable || i == MAX_RETRIES {
                    return Err(last.trim_start_matches("RETRYABLE ").to_string());
                }
                let mut backoff: u64 = 600 * (1 << i);
                if backoff > 8000 {
                    backoff = 8000;
                }
                if let Some(ra) = last.split(" RA:").nth(1).and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse::<u64>().ok()) {
                    backoff = ra;
                }
                tokio::time::sleep(Duration::from_millis(backoff + rand_ms(300))).await;
            }
        }
    }
    Err(last)
}
async fn fetch_page(raw: &str) -> Result<String, String> {
    let site = if raw.starts_with('/') { sanitize_url(raw)? } else { assert_site_url(raw)? };
    if let Some(hit) = cache_get(&site) {
        return Ok(hit);
    }
    let slot = {
        let mut inf = State::global().inflight.lock().unwrap();
        if let Some(s) = inf.get(&site) {
            let s = s.clone();
            drop(inf);
            s.notify.notified().await;
            if let Some(hit) = cache_get(&site) {
                return Ok(hit);
            }
            let r = s.result.lock().unwrap().clone().unwrap_or(Err("inflight lost".into()));
            return r;
        }
        let s = std::sync::Arc::new(Slot { notify: tokio::sync::Notify::new(), result: Mutex::new(None) });
        inf.insert(site.clone(), s.clone());
        s
    };
    let v = Limiter::global().run(|| with_retry(&site, None, vec![])).await;
    if let Ok(ref html) = v {
        cache_set(&site, html.clone());
    }
    *slot.result.lock().unwrap() = Some(v.clone());
    State::global().inflight.lock().unwrap().remove(&site);
    slot.notify.notify_waiters();
    v
}
async fn post_ajax(raw: &str, body: String, post_url: &str) -> Result<String, String> {
    let site = if raw.starts_with('/') { sanitize_url(raw)? } else { assert_site_url(raw)? };
    if body.len() > 8192 {
        return Err("POST body too large".into());
    }
    let rf = if post_url.is_empty() { format!("{}/", base()) } else if post_url.starts_with('/') { sanitize_url(post_url)? } else { assert_site_url(post_url)? };
    let extra = vec![
        ("accept".into(), "*/*".into()),
        ("origin".into(), base()),
        ("referer".into(), rf),
        ("x-requested-with".into(), "XMLHttpRequest".into()),
        ("content-type".into(), "application/x-www-form-urlencoded; charset=UTF-8".into()),
    ];
    Limiter::global().run(|| with_retry(&site, Some(body.clone()), extra.clone())).await
}

// === PARSE HELPERS ===
fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("selector")
}
fn txt(s: &str, max: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = t.trim().to_string();
    // JS .slice(max) semantics: count UTF-16 code units, never split a rune
    let n16: usize = t.chars().map(|c| if (c as u32) > 0xFFFF { 2 } else { 1 }).sum();
    if n16 > max {
        let mut acc = 0usize;
        let mut end = t.len();
        for (i, c) in t.char_indices() {
            if acc >= max {
                end = i;
                break;
            }
            acc += if (c as u32) > 0xFFFF { 2 } else { 1 };
        }
        t[..end].to_string()
    } else {
        t
    }
}
fn num_in(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect::<String>().trim().to_string()
}
fn opt(s: String) -> Value {
    if s.is_empty() {
        Value::Null
    } else {
        Value::String(s)
    }
}
fn img_of(el: scraper::ElementRef) -> String {
    let img = el.select(&sel("img")).next();
    match img {
        None => String::new(),
        Some(i) => i
            .value()
            .attr("data-src")
            .filter(|v| !v.is_empty())
            .or_else(|| i.value().attr("data-lazy-src").filter(|v| !v.is_empty()))
            .or_else(|| i.value().attr("src"))
            .unwrap_or("")
            .to_string(),
    }
}
fn href_of(el: scraper::ElementRef) -> String {
    el.select(&sel("a"))
        .next()
        .and_then(|a| a.value().attr("href"))
        .unwrap_or("")
        .to_string()
}
fn first_text(doc: &Html, sels: &[&str], max: usize) -> String {
    for s in sels {
        let t = txt(&doc.select(&sel(s)).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), max);
        if !t.is_empty() {
            return t;
        }
    }
    String::new()
}
fn nonce_re() -> Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[a-f0-9]{6,20}$").unwrap()).clone()
}
fn is_nonce(s: &str) -> bool {
    nonce_re().is_match(s)
}
fn slice_balanced(src: &str, start: usize, limit: usize) -> Option<String> {
    let b = src.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let end = (start + limit).min(b.len());
    let mut p = start;
    while p < end {
        let ch = b[p];
        if in_str {
            if esc {
                esc = false;
            } else if ch == b'\\' {
                esc = true;
            } else if ch == b'"' {
                in_str = false;
            }
        } else if ch == b'"' {
            in_str = true;
        } else if ch == b'{' {
            depth += 1;
        } else if ch == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(src[start..=p].to_string());
            }
        }
        p += 1;
    }
    None
}
fn ep_url_re() -> Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(?:episode[-/](\d+))|(?:/(\d+)(?:/|\\.html|$))").unwrap()).clone()
}
fn extract_episode_from_url(u: &str) -> String {
    match ep_url_re().captures(u) {
        None => String::new(),
        Some(c) => c
            .get(1)
            .or_else(|| c.get(2))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default(),
    }
}
fn extract_post_id(u: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"/(\d{4,})\.html").unwrap());
    r.captures(u).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()).unwrap_or_default()
}
fn extract_page_var(html: &str, names: &[&str]) -> Option<Map<String, Value>> {
    let doc = Html::parse_document(if html.len() > 2_000_000 { &html[..2_000_000] } else { html });
    let mut scripts: Vec<String> = vec![];
    for el in doc.select(&sel(r#"script[src^="data:text/javascript;base64,"]"#)) {
        if let Some(src) = el.value().attr("src") {
            const PFX: &str = "data:text/javascript;base64,";
            if let Some(b) = src.strip_prefix(PFX) {
                scripts.push(b.to_string());
            }
        }
    }
    for el in doc.select(&sel("script:not([src])")) {
        let t = el.inner_html();
        if names.iter().any(|v| t.contains(v)) {
            scripts.push(B64.encode(t.as_bytes()));
        }
    }
    for b64 in scripts {
        let js = match B64.decode(b64.as_bytes()) {
            Ok(v) => String::from_utf8_lossy(&v).into_owned(),
            Err(_) => continue,
        };
        let mut hit: Option<usize> = None;
        for v in names {
            if let Some(i) = js.find(&format!("var {v}=")) {
                hit = Some(i);
                break;
            }
        }
        let hit = match hit {
            Some(h) => h,
            None => continue,
        };
        let rel = match js[hit..].find('{') {
            Some(i) => hit + i,
            None => continue,
        };
        let slice = match slice_balanced(&js, rel, 20000) {
            Some(s) => s,
            None => continue,
        };
        if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&slice) {
            return Some(m);
        }
    }
    None
}
fn extract_embed_url(html: &str) -> String {
    let doc = Html::parse_document(if html.len() > 2_000_000 { &html[..2_000_000] } else { html });
    if let Some(f) = doc.select(&sel("iframe")).next() {
        if let Some(v) = f.value().attr("src").filter(|v| !v.is_empty()) {
            return v.to_string();
        }
        if let Some(v) = f.value().attr("data-src").filter(|v| !v.is_empty()) {
            return v.to_string();
        }
    }
    if let Some(v) = doc.select(&sel("video source")).next().and_then(|e| e.value().attr("src")) {
        return v.to_string();
    }
    if let Some(v) = doc.select(&sel("video")).next().and_then(|e| e.value().attr("src")) {
        return v.to_string();
    }
    static R1: OnceLock<Regex> = OnceLock::new();
    let r1 = R1.get_or_init(|| Regex::new(r#"(?i)<iframe[^>]+(?:src|data-src)=["']([^"']+)["']"#).unwrap());
    if let Some(c) = r1.captures(html) {
        return c[1].to_string();
    }
    static R2: OnceLock<Regex> = OnceLock::new();
    let r2 = R2.get_or_init(|| Regex::new(r#"https?://[^\s"'\\<>]+"#).unwrap());
    r2.find(html).map(|m| m.as_str().to_string()).unwrap_or_default()
}

// card builders return serde_json objects (identical field names to TS)
fn parse_cards(doc: &Html, selector: &str, pick: impl Fn(scraper::ElementRef) -> Option<Value>) -> Vec<Value> {
    let mut out = vec![];
    for el in doc.select(&sel(selector)) {
        if let Some(c) = pick(el) {
            let ok = c.get("title").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false)
                && c.get("url").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
            if ok {
                out.push(c);
            }
        }
    }
    out
}
fn parse_article_grid(doc: &Html) -> Vec<Value> {
    doc.select(&sel("article.animeseries"))
        .filter_map(|el| {
            let u = href_of(el);
            if u.is_empty() {
                return None;
            }
            let t0 = el.select(&sel(".title span")).next().and_then(|e| e.value().attr("data-title-default")).unwrap_or("");
            let mut title = txt(t0, 200);
            if title.is_empty() {
                title = txt(&el.select(&sel(".title")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 200);
            }
            if title.is_empty() {
                return None;
            }
            Some(json!({
                "title": title,
                "episode": num_in(&el.select(&sel(".episodes")).next().map(|e| e.text().collect::<String>()).unwrap_or_default()),
                "url": u,
                "thumbnail": img_of(el),
            }))
        })
        .collect()
}
fn parse_as_cards(doc: &Html, selector: &str) -> Vec<Value> {
    let s = if selector.is_empty() { ".as-anime-card" } else { selector };
    parse_cards(doc, s, |el| {
        let u = if el.value().name() == "a" {
            el.value().attr("href").unwrap_or("").to_string()
        } else {
            href_of(el)
        };
        let u = if u.is_empty() { href_of(el) } else { u };
        if u.is_empty() {
            return None;
        }
        let t = el.select(&sel(".as-anime-title")).next();
        let mut title = t
            .and_then(|e| e.value().attr("data-title-default"))
            .map(|v| txt(v, 200))
            .unwrap_or_default();
        if title.is_empty() {
            title = txt(&t.map(|e| e.text().collect::<String>()).unwrap_or_default(), 200);
        }
        if title.is_empty() {
            return None;
        }
        let mut genres = vec![];
        for g in el.select(&sel(".as-genres span, .jr-genre-pill")) {
            let x = txt(&g.text().collect::<String>(), 40);
            if !x.is_empty() {
                genres.push(Value::String(x));
            }
        }
        let mut m = Map::new();
        m.insert("title".into(), Value::String(title));
        m.insert("url".into(), Value::String(u));
        m.insert("thumbnail".into(), Value::String(img_of(el)));
        let r = num_in(&el.select(&sel(".as-rating")).next().map(|e| e.text().collect::<String>()).unwrap_or_default());
        if !r.is_empty() {
            m.insert("rating".into(), Value::String(r));
        }
        static NW: OnceLock<Regex> = OnceLock::new();
        let nw = NW.get_or_init(|| Regex::new(r"^[^\w]+").unwrap());
        let ty = txt(&nw.replace_all(&el.select(&sel(".as-type")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), ""), 20);
        if !ty.is_empty() {
            m.insert("type".into(), Value::String(ty));
        }
        let se = txt(
            &el.select(&sel(".as-season")).next().map(|e| e.text().collect::<String>()).unwrap_or_default().replace('📅', ""),
            30,
        );
        let se = se.trim().to_string();
        if !se.is_empty() {
            m.insert("season".into(), Value::String(se));
        }
        let sy = txt(&el.select(&sel(".as-synopsis")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 300);
        if !sy.is_empty() {
            m.insert("synopsis".into(), Value::String(sy));
        }
        if !genres.is_empty() {
            m.insert("genres".into(), Value::Array(genres));
        }
        Some(Value::Object(m))
    })
}

// === SCRAPERS (all return serde_json Values, TS-identical shapes) ===
fn doc_of(html: &str) -> Html {
    Html::parse_document(if html.len() > 2_000_000 { &html[..2_000_000] } else { html })
}
async fn get_latest(page: i64) -> Result<Value, String> {
    let p = clamp_page(page);
    let u = if p == 1 { format!("{}/", base()) } else { format!("{}/page/{p}/", base()) };
    Ok(Value::Array(parse_article_grid(&doc_of(&fetch_page(&u).await?))))
}
async fn get_home(page: i64) -> Result<Value, String> {
    let p = clamp_page(page);
    let u = if p == 1 { format!("{}/", base()) } else { format!("{}/page/{p}/", base()) };
    let doc = doc_of(&fetch_page(&u).await?);
    let mut pop = vec![];
    for el in doc.select(&sel("a.popseries")) {
        let href = el.value().attr("href").unwrap_or("");
        if href.is_empty() {
            continue;
        }
        let img = el.select(&sel("img")).next();
        let title = txt(img.and_then(|i| i.value().attr("alt")).unwrap_or(""), 200);
        if title.is_empty() {
            continue;
        }
        pop.push(json!({"title": title, "url": href, "thumbnail": img.and_then(|i| i.value().attr("src")).unwrap_or("")}));
    }
    let mut series = Map::new();
    if !pop.is_empty() {
        series.insert("Populer".into(), Value::Array(pop));
    }
    Ok(json!({"latestEpisodes": parse_article_grid(&doc), "series": series}))
}
async fn search_anime(q: &str) -> Result<Value, String> {
    let query = clean_query(q)?;
    let u = format!("{}/?s={}", base(), urlencoding(&query));
    Ok(Value::Array(parse_as_cards(&doc_of(&fetch_page(&u).await?), "")))
}
fn urlencoding(s: &str) -> String {
    // minimal percent-encode for query values
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else if b == b' ' {
            o.push('+');
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}
static ADV_KEYS: &[&str] = &["sort","status","type","score_min","score_max","year_min","year_max","genre","rating","mode","studio","season","s"];
async fn advanced_search(opts: &HashMap<String, String>) -> Result<Value, String> {
    let mut parts: Vec<(String, String)> = vec![];
    for k in ADV_KEYS {
        if let Some(v) = opts.get(*k) {
            if !v.is_empty() {
                let mut vv = v.clone();
                if vv.len() > 64 {
                    vv.truncate(64);
                }
                parts.push((k.to_string(), vv));
            }
        }
    }
    let page = opts.get("page").and_then(|v| v.parse::<i64>().ok()).map(clamp_page).unwrap_or(1);
    let b = if page == 1 { format!("{}/anime/", base()) } else { format!("{}/anime/page/{page}/", base()) };
    let qs: String = parts.iter().map(|(k, v)| format!("{}={}", k, urlencoding(v))).collect::<Vec<_>>().join("&");
    let u = if qs.is_empty() { b } else { format!("{b}?{qs}") };
    match fetch_page(&u).await {
        Ok(html) => Ok(Value::Array(parse_as_cards(&doc_of(&html), ""))),
        Err(e) => {
            let g = opts.get("genre").cloned().unwrap_or_default();
            if g.is_empty() || !(e.contains("WAF blocked") || e.contains("HTTP 403") || e.contains("HTTP 500")) {
                return Err(e);
            }
            genre_fallback(opts).await
        }
    }
}
async fn genre_fallback(opts: &HashMap<String, String>) -> Result<Value, String> {
    let slug = clean_slug(opts.get("genre").map(|s| s.as_str()).unwrap_or(""))?;
    let mut out: Vec<Value> = vec![];
    for p in 1..=3 {
        let u = if p == 1 { format!("{}/genres/{slug}/", base()) } else { format!("{}/genres/{slug}/page/{p}/", base()) };
        let cards = parse_as_cards(&doc_of(&fetch_page(&u).await?), "");
        if cards.is_empty() {
            break;
        }
        let n = cards.len();
        out.extend(cards);
        if n < 20 {
            break;
        }
    }
    let min: Option<f64> = opts.get("score_min").and_then(|v| v.parse().ok());
    let max: Option<f64> = opts.get("score_max").and_then(|v| v.parse().ok());
    let typ = opts.get("type").map(|v| v.to_lowercase()).unwrap_or_default();
    let mut res: Vec<Value> = out
        .into_iter()
        .filter(|c| {
            let r: Option<f64> = c.get("rating").and_then(|v| v.as_str()).and_then(|s| s.parse().ok());
            if let Some(mn) = min {
                match r {
                    Some(r) if r >= mn => {}
                    _ => return false,
                }
            }
            if let Some(mx) = max {
                match r {
                    Some(r) if r <= mx => {}
                    _ => return false,
                }
            }
            if !typ.is_empty() {
                let t = c.get("type").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                if t != typ {
                    return false;
                }
            }
            true
        })
        .collect();
    match opts.get("sort").map(|s| s.as_str()) {
        Some("series_skor") => res.sort_by(|a, b| {
            // TS semantics: parseFloat(x) || 0
            let ra: f64 = a.get("rating").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let rb: f64 = b.get("rating").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            rb.partial_cmp(&ra).unwrap()
        }),
        Some("series_title") => res.sort_by(|a, b| {
            a.get("title").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("title").and_then(|v| v.as_str()).unwrap_or(""))
        }),
        _ => {}
    }
    Ok(Value::Array(res))
}
async fn get_list(page: i64) -> Result<Value, String> {
    let p = clamp_page(page);
    let u = if p == 1 { format!("{}/anime/", base()) } else { format!("{}/anime/page/{p}/", base()) };
    Ok(Value::Array(parse_as_cards(&doc_of(&fetch_page(&u).await?), "")))
}
async fn get_anime_detail(raw: &str) -> Result<Value, String> {
    let site = assert_site_url(raw)?;
    let doc = doc_of(&fetch_page(&site).await?);
    let mut title = doc
        .select(&sel("h1.entry-title span[data-title-default]"))
        .next()
        .and_then(|e| e.value().attr("data-title-default"))
        .map(|v| txt(v, 300))
        .unwrap_or_default();
    if title.is_empty() {
        let h1 = first_text(&doc, &["h1.entry-title"], 300);
        static R: OnceLock<Regex> = OnceLock::new();
        let r = R.get_or_init(|| Regex::new(r"(?i)^Nonton\s+|\s+Sub Indo$").unwrap());
        title = r.replace_all(&h1, "").trim().to_string();
    }
    if title.is_empty() {
        title = txt(doc.select(&sel(r#"meta[property="og:title"]"#)).next().and_then(|e| e.value().attr("content")).unwrap_or(""), 300);
    }
    if title.is_empty() {
        return Ok(Value::Null);
    }
    let mut meta: HashMap<String, String> = HashMap::new();
    for li in doc.select(&sel("ul.details-list li")) {
        let label = txt(&li.select(&sel(".detail-label")).next().map(|e| e.text().collect::<String>()).unwrap_or_default().trim_end_matches(':').to_string(), 40);
        if label.is_empty() {
            continue;
        }
        // value = li text minus label text
        let full = li.text().collect::<String>();
        let lab = li.select(&sel(".detail-label")).next().map(|e| e.text().collect::<String>()).unwrap_or_default();
        let value = txt(full.replace(&lab, "").as_str(), 300);
        if value.is_empty() || value == "-" || meta.contains_key(&label) {
            continue;
        }
        meta.insert(label, value);
    }
    let gm = |l: &str| -> String {
        if let Some(v) = meta.get(l) {
            return v.clone();
        }
        let ll = l.to_lowercase();
        for (k, v) in &meta {
            if k.to_lowercase().contains(&ll) {
                return v.clone();
            }
        }
        String::new()
    };
    let quick: Vec<String> = doc.select(&sel(".anime-card__quick-info .info-item")).map(|e| txt(&e.text().collect::<String>(), 60)).collect();
    let fq = |sub: &str| -> String { quick.iter().find(|q| q.to_lowercase().contains(sub)).cloned().unwrap_or_default() };
    let mut genres = vec![];
    for g in doc.select(&sel("a.genre-tag")) {
        let x = txt(&g.text().collect::<String>(), 40);
        if !x.is_empty() {
            genres.push(Value::String(x));
        }
    }
    let mut eps = vec![];
    for a in doc.select(&sel(".episode-list-items a.episode-item")) {
        let u = a.value().attr("href").or_else(|| a.value().attr("data-episode-url")).unwrap_or("");
        if u.is_empty() {
            continue;
        }
        eps.push(json!({
            "title": txt(&a.select(&sel(".ep-title")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 200),
            "date": txt(&a.select(&sel(".ep-date")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 40),
            "url": u,
        }));
    }
    let mut title_jp = gm("Japanese");
    if title_jp.is_empty() {
        title_jp = gm("Synonyms");
    }
    let mut syn = txt(&doc.select(&sel(".synopsis-prose p")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 2000);
    if syn.is_empty() {
        syn = txt(doc.select(&sel(r#"meta[name="description"]"#)).next().and_then(|e| e.value().attr("content")).unwrap_or(""), 2000);
    }
    let mut poster = doc.select(&sel(".anime-card__sidebar img")).next().and_then(|e| e.value().attr("src")).unwrap_or("").to_string();
    if poster.is_empty() {
        poster = doc.select(&sel(r#"meta[property="og:image"]"#)).next().and_then(|e| e.value().attr("content")).unwrap_or("").to_string();
    }
    let first = doc.select(&sel(".meta-episode-item.first a")).next().and_then(|e| e.value().attr("href")).unwrap_or("").to_string();
    let last = doc.select(&sel(".meta-episode-item.last a")).next().and_then(|e| e.value().attr("href")).unwrap_or("").to_string();
    let first = if first.is_empty() { eps.last().and_then(|e| e.get("url")).and_then(|v| v.as_str()).unwrap_or("").to_string() } else { first };
    let last = if last.is_empty() { eps.first().and_then(|e| e.get("url")).and_then(|v| v.as_str()).unwrap_or("").to_string() } else { last };
    let mut pop = gm("Popularity");
    if pop.is_empty() {
        pop = gm("Popul");
    }
    Ok(json!({
        "title": title, "titleEn": gm("English"), "titleJp": title_jp,
        "score": txt(&doc.select(&sel(".anime-card__score .value")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 10),
        "type": txt(&doc.select(&sel(".anime-card__score .type")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 20),
        "synopsis": syn, "genres": genres,
        "studios": gm("Studio"), "rating": gm("Rating"), "popularity": pop,
        "members": gm("Member"), "aired": gm("Aired"),
        "status": txt(&doc.select(&sel(".status-airing")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 30),
        "totalEpisodes": fq("episode"), "duration": fq("min"),
        "season": txt(&doc.select(&sel(".info-item.season")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 30),
        "poster": poster,
        "trailer": doc.select(&sel("a.trailerbutton")).next().and_then(|e| e.value().attr("href")).unwrap_or(""),
        "episodes": eps, "firstEpisode": first, "lastEpisode": last,
        "recommended": parse_as_cards(&doc, ".related .as-anime-card"),
    }))
}
async fn episode_servers(site: &str, doc: &Html, html: &str) -> Result<(Vec<Value>, String, String, String), String> {
    let mut servers = vec![];
    let mut post = String::new();
    for el in doc.select(&sel("li.serverplayer")) {
        let name = txt(el.value().attr("data-type").unwrap_or(""), 40);
        if name.is_empty() {
            continue;
        }
        let pid = el.value().attr("data-post").unwrap_or("").to_string();
        if !pid.is_empty() {
            post = pid.clone();
        }
        let n: i64 = el.value().attr("data-nume").unwrap_or("0").parse().unwrap_or(0);
        let n = if n == 0 { servers.len() as i64 + 1 } else { n };
        servers.push(json!({"n": n, "name": name, "postId": pid, "active": el.value().classes().any(|c| c == "on")}));
    }
    if servers.is_empty() {
        return Err("No servers found (page layout changed?)".into());
    }
    servers.sort_by_key(|s| s.get("n").and_then(|v| v.as_i64()).unwrap_or(0));
    let frame = doc.select(&sel("#videoku iframe, .player_embed iframe")).next();
    let mut def = frame.and_then(|f| f.value().attr("data-src")).unwrap_or("").to_string();
    if def.is_empty() {
        def = frame.and_then(|f| f.value().attr("src")).unwrap_or("").to_string();
    }
    let nonce = extract_page_var(html, &["kotakajax"]).and_then(|m| m.get("nonce").and_then(|v| v.as_str()).map(|s| s.to_string())).unwrap_or_default();
    Ok((servers, post, def, nonce))
}
async fn get_servers(raw: &str) -> Result<Value, String> {
    let site = assert_site_url(raw)?;
    let html = fetch_page(&site).await?;
    let doc = doc_of(&html);
    let (servers, post, def, nonce) = episode_servers(&site, &doc, &html).await?;
    Ok(json!({"postId": post, "servers": servers, "defaultEmbed": def, "nonce": nonce}))
}
fn pick_server(servers: &[Value], sel: &str) -> Result<Value, String> {
    let sel = if sel.is_empty() { "1" } else { sel };
    if let Ok(mut n) = sel.parse::<i64>() {
        if n < 1 {
            n = 1;
        }
        if n > servers.len() as i64 {
            n = servers.len() as i64;
        }
        for s in servers {
            if s.get("n").and_then(|v| v.as_i64()) == Some(n) {
                return Ok(s.clone());
            }
        }
        return servers.get((n - 1) as usize).cloned().ok_or_else(|| "No servers".to_string());
    }
    let want = sel.to_lowercase();
    for s in servers {
        if s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase() == want {
            return Ok(s.clone());
        }
    }
    for s in servers {
        if s.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase().contains(&want) {
            return Ok(s.clone());
        }
    }
    Err(format!("Unknown server \"{sel}\" (use servers command to list)"))
}
async fn resolve_server(raw: &str, s: &str) -> Result<Value, String> {
    let site = assert_site_url(raw)?;
    let html = fetch_page(&site).await?;
    let doc = doc_of(&html);
    let (servers, post, _def, nonce) = episode_servers(&site, &doc, &html).await?;
    let tab = pick_server(&servers, s)?;
    if !is_nonce(&nonce) {
        return Err("player_ajax nonce not found".into());
    }
    let mut p = tab.get("postId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if p.is_empty() {
        p = post;
    }
    let n = tab.get("n").and_then(|v| v.as_i64()).unwrap_or(1).to_string();
    let name = tab.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let body = format!("action=player_ajax&post={}&nume={}&serverName={}&nonce={}", urlencoding(&p), n, urlencoding(&name), nonce);
    let res = post_ajax(&format!("{}/wp-admin/admin-ajax.php", base()), body, &site).await?;
    if res.trim().is_empty() || res.trim() == "0" {
        return Err("Server returned empty embed (expired nonce?)".into());
    }
    let embed = extract_embed_url(&res);
    if embed.is_empty() || !is_valid_url(&embed) {
        return Err("No embed URL in server response".into());
    }
    Ok(Value::String(embed))
}
async fn get_stream(raw: &str, n: i64) -> Result<Value, String> {
    match resolve_server(raw, &n.to_string()).await {
        Ok(v) => Ok(v),
        Err(_) => {
            let site = assert_site_url(raw)?;
            let doc = doc_of(&fetch_page(&site).await?);
            let f = doc.select(&sel("#videoku iframe, .player_embed iframe")).next();
            let mut u = f.and_then(|e| e.value().attr("data-src")).unwrap_or("").to_string();
            if u.is_empty() {
                u = f.and_then(|e| e.value().attr("src")).unwrap_or("").to_string();
            }
            if u.is_empty() {
                return Err("No stream found".into());
            }
            Ok(Value::String(u))
        }
    }
}
async fn get_episode_info(raw: &str) -> Result<Value, String> {
    let site = assert_site_url(raw)?;
    let html = fetch_page(&site).await?;
    let doc = doc_of(&html);
    let mut title = first_text(&doc, &["h1.entry-title", "h2.name"], 300);
    if title.is_empty() {
        title = txt(doc.select(&sel(r#"meta[property="og:title"]"#)).next().and_then(|e| e.value().attr("content")).unwrap_or(""), 300);
    }
    if title.is_empty() {
        return Ok(Value::Null);
    }
    let (servers, post, def, _nonce) = episode_servers(&site, &doc, &html).await.unwrap_or((vec![], String::new(), String::new(), String::new()));
    let mut post_id = extract_post_id(raw);
    if !post.is_empty() {
        post_id = post;
    }
    let streams: Vec<Value> = if !servers.is_empty() {
        servers
            .iter()
            .map(|s| {
                let active = s.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                json!({
                    "server": s.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    "embedUrl": if active { def.clone() } else { String::new() },
                    "rawHtml": format!("<span>S-{}</span>", s.get("name").and_then(|v| v.as_str()).unwrap_or("")),
                })
            })
            .collect()
    } else {
        let f = doc.select(&sel("#videoku iframe, .player_embed iframe")).next();
        let mut u = f.and_then(|e| e.value().attr("data-src")).unwrap_or("").to_string();
        if u.is_empty() {
            u = f.and_then(|e| e.value().attr("src")).unwrap_or("").to_string();
        }
        if u.is_empty() { vec![] } else { vec![json!({"server": "default", "embedUrl": u, "rawHtml": ""})] }
    };
    let mut downloads = vec![];
    let mut collect = |sels: &str, fmt: &dyn Fn(scraper::ElementRef) -> String| {
        for el in doc.select(&sel(sels)) {
            let format = fmt(el);
            let format = if format.is_empty() { "Download".to_string() } else { format };
            let mut links = vec![];
            for a in el.select(&sel("a")) {
                let label = txt(&a.text().collect::<String>(), 40);
                let href = a.value().attr("href").unwrap_or("");
                if !label.is_empty() && !href.is_empty() && is_valid_url(href) {
                    links.push(json!({"label": label, "url": href}));
                }
            }
            if !links.is_empty() {
                downloads.push(json!({"format": format, "links": links}));
            }
        }
    };
    collect(".listlink", &|el| txt(&el.select(&sel("span")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 30));
    if downloads.is_empty() {
        // legacy: dd + preceding dt
        for dd in doc.select(&sel("div dl.download > dd")) {
            let mut links = vec![];
            for a in dd.select(&sel("a")) {
                let label = txt(&a.text().collect::<String>(), 40);
                let href = a.value().attr("href").unwrap_or("");
                if !label.is_empty() && !href.is_empty() && is_valid_url(href) {
                    links.push(json!({"label": label, "url": href}));
                }
            }
            if !links.is_empty() {
                downloads.push(json!({"format": "Download", "links": links}));
            }
        }
    }
    Ok(json!({"title": title, "postId": post_id, "streams": streams, "downloads": downloads}))
}
async fn get_nav(raw: &str) -> Result<Value, String> {
    let site = assert_site_url(raw)?;
    let html = fetch_page(&site).await?;
    let doc = doc_of(&html);
    let (mut prev, mut all, mut next) = (String::new(), String::new(), String::new());
    for a in doc.select(&sel("#navigation-episode a")) {
        let href = a.value().attr("href").unwrap_or("");
        if href.is_empty() {
            continue;
        }
        let t = format!("{} {}", a.text().collect::<String>(), a.value().attr("title").unwrap_or("")).to_lowercase();
        if t.contains("prev") {
            prev = href.to_string();
        } else if t.contains("next") {
            next = href.to_string();
        } else if href.contains("/anime/") {
            all = href.to_string();
        } else if all.is_empty() {
            all = href.to_string();
        }
    }
    let mut num = extract_episode_from_url(&site);
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r#""episodeNumber"\s*:\s*"?(\d+)"?"#).unwrap());
    if let Some(c) = r.captures(&html) {
        num = c[1].to_string();
    }
    Ok(json!({"prev": prev, "all": all, "next": next, "episodeNumber": num}))
}
async fn get_meta_ep(raw: &str) -> Result<Value, String> {
    let site = assert_site_url(raw)?;
    let html = fetch_page(&site).await?;
    let trace = extract_page_var(&html, &["episodeToTrace", "episodeToTrack"]);
    let gs = |k: &str| -> String { trace.as_ref().and_then(|m| m.get(k)).and_then(|v| v.as_str()).unwrap_or("").to_string() };
    let mut num = gs("episodeNumber");
    if num.is_empty() {
        static R: OnceLock<Regex> = OnceLock::new();
        let r = R.get_or_init(|| Regex::new(r#""episodeNumber"\s*:\s*"?(\d+)"?"#).unwrap());
        num = r.captures(&html).map(|c| c[1].to_string()).unwrap_or_else(|| extract_episode_from_url(&site));
    }
    let (mut st, mut su) = (gs("seriesTitle"), gs("seriesUrl"));
    if st.is_empty() || su.is_empty() {
        static R: OnceLock<Regex> = OnceLock::new();
        let r = R.get_or_init(|| Regex::new(r#""partOfSeries"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"url"\s*:\s*"([^"]+)""#).unwrap());
        if let Some(c) = r.captures(&html) {
            if st.is_empty() {
                st = c[1].to_string();
            }
            if su.is_empty() {
                su = c[2].to_string();
            }
        }
    }
    let mut genres = vec![];
    if let Some(Value::Array(g)) = trace.as_ref().and_then(|m| m.get("genres")) {
        for x in g.iter().take(20) {
            if let Some(s) = x.as_str() {
                genres.push(Value::String(s.to_string()));
            }
        }
    }
    Ok(json!({"episodeNumber": num, "seriesTitle": st, "seriesUrl": su, "poster": gs("poster"), "genres": genres}))
}
async fn load_more(ids: &[i64], offset: i64) -> Result<Value, String> {
    let home = fetch_page(&format!("{}/", base())).await?;
    let nonce = extract_page_var(&home, &["misha_loadmore_params"])
        .and_then(|m| m.get("nonce").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    if !is_nonce(&nonce) {
        return Err("loadmore nonce not found".into());
    }
    let off = offset.clamp(0, 100000);
    let mut parts = vec![format!("action=loadmore"), format!("nonce={nonce}"), format!("offset={off}")];
    for id in ids.iter().take(200) {
        parts.push(format!("displayed_posts[]={id}"));
    }
    let res = post_ajax(&format!("{}/wp-admin/admin-ajax.php", base()), parts.join("&"), &format!("{}/", base())).await?;
    if res.trim().is_empty() || res.trim() == "0" {
        return Ok(Value::Array(vec![]));
    }
    Ok(Value::Array(parse_article_grid(&doc_of(&res))))
}
async fn get_genres(sort: &str) -> Result<Value, String> {
    let mut u = format!("{}/genres/", base());
    if !sort.is_empty() {
        let s = sort.to_lowercase();
        if !["az", "popular", "ongoing"].contains(&s.as_str()) {
            return Err("Sort must be az|popular|ongoing".into());
        }
        u = format!("{u}?sort={s}&mode=sort");
    }
    let doc = doc_of(&fetch_page(&u).await?);
    static D: OnceLock<Regex> = OnceLock::new();
    let d = D.get_or_init(|| Regex::new(r"[\d,]+").unwrap());
    let mut out = vec![];
    for el in doc.select(&sel("a.genre-grid-card")) {
        let name = txt(&el.select(&sel(".genre-name")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 60);
        let href = el.value().attr("href").unwrap_or("");
        if name.is_empty() || href.is_empty() {
            continue;
        }
        let total: i64 = d.find(&el.select(&sel(".detail-item.count")).next().map(|e| e.text().collect::<String>()).unwrap_or_default())
            .map(|m| m.as_str().replace(',', "").parse().unwrap_or(0)).unwrap_or(0);
        let ongoing: i64 = d.find(&el.select(&sel(".detail-item.ongoing")).next().map(|e| e.text().collect::<String>()).unwrap_or_default())
            .map(|m| m.as_str().replace(',', "").parse().unwrap_or(0)).unwrap_or(0);
        out.push(json!({"name": name, "url": href, "total": total, "ongoing": ongoing}));
    }
    Ok(Value::Array(out))
}
async fn get_genre_anime(slug: &str, page: i64) -> Result<Value, String> {
    let s = clean_slug(slug)?;
    let p = clamp_page(page);
    let u = if p == 1 { format!("{}/genres/{s}/", base()) } else { format!("{}/genres/{s}/page/{p}/", base()) };
    Ok(Value::Array(parse_as_cards(&doc_of(&fetch_page(&u).await?), "")))
}
async fn get_ongoing(sort: &str) -> Result<Value, String> {
    let mut u = format!("{}/ongoing-list/", base());
    if !sort.is_empty() {
        static R: OnceLock<Regex> = OnceLock::new();
        let r = R.get_or_init(|| Regex::new(r"^[a-z0-9_]+$").unwrap());
        if !r.is_match(sort) {
            return Err("Invalid sort value".into());
        }
        let mut s = sort.to_lowercase();
        if s.len() > 32 {
            s.truncate(32);
        }
        u = format!("{u}?sort={s}&mode=sort");
    }
    let doc = doc_of(&fetch_page(&u).await?);
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"rarity-(\d)").unwrap());
    let mut out = vec![];
    for el in doc.select(&sel("a.gacha-card")) {
        let href = el.value().attr("href").unwrap_or("");
        if href.is_empty() {
            continue;
        }
        let title = txt(&el.select(&sel("h3.title")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 200);
        if title.is_empty() {
            continue;
        }
        let rarity: i64 = r.captures(el.value().attr("class").unwrap_or("")).and_then(|c| c[1].parse().ok()).unwrap_or(3);
        out.push(json!({
            "title": title, "url": href,
            "currentEpisode": txt(&el.select(&sel(".current-ep")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 20),
            "totalEpisode": txt(&el.select(&sel(".total-ep")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 20),
            "score": txt(&el.select(&sel(".skor-angka")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 10).trim_matches(|c| c == '(' || c == ')').to_string(),
            "rarity": rarity,
        }));
    }
    Ok(Value::Array(out))
}
async fn get_popular() -> Result<Value, String> {
    let doc = doc_of(&fetch_page(&format!("{}/popular-series/", base())).await?);
    let mut labels: HashMap<String, String> = HashMap::new();
    for li in doc.select(&sel(".tabs li")) {
        let id = li.value().attr("data-tab").unwrap_or("");
        let label = txt(&li.text().collect::<String>(), 40);
        if !id.is_empty() && !label.is_empty() {
            labels.insert(id.to_string(), label);
        }
    }
    let mut out = vec![];
    for tab in doc.select(&sel(".tab-content")) {
        let id = tab.value().attr("id").unwrap_or("");
        let genre = labels.get(id).cloned().unwrap_or_else(|| id.to_string());
        for el in tab.select(&sel(".animeseries")) {
            let u = href_of(el);
            if u.is_empty() {
                continue;
            }
            let title = txt(&el.select(&sel(".title span")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 200);
            if title.is_empty() {
                continue;
            }
            out.push(json!({
                "title": title, "url": u, "thumbnail": img_of(el),
                "score": num_in(&el.select(&sel(".kotakscore")).next().map(|e| e.text().collect::<String>()).unwrap_or_default()),
                "genre": genre,
            }));
        }
    }
    Ok(Value::Array(out))
}
async fn get_schedule() -> Result<Value, String> {
    let doc = doc_of(&fetch_page(&format!("{}/jadwal-rilis/", base())).await?);
    let mut out = vec![];
    for day in doc.select(&sel(".as-tab-content")) {
        let name = txt(day.value().attr("id").unwrap_or(""), 20);
        if name.is_empty() {
            continue;
        }
        let mut entries = vec![];
        for el in day.select(&sel(".as-anime-card")) {
            let mut link = el.value().attr("href").unwrap_or("").to_string();
            if link.is_empty() || el.value().name() != "a" {
                link = href_of(el);
            }
            if link.is_empty() {
                continue;
            }
            let title = txt(&el.select(&sel(".as-anime-title")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 200);
            if title.is_empty() {
                continue;
            }
            let mut genres = vec![];
            for g in el.select(&sel(".jr-genre-pill")) {
                let x = txt(&g.text().collect::<String>(), 40);
                if !x.is_empty() {
                    genres.push(Value::String(x));
                }
            }
            let mut slot = Map::new();
            slot.insert("title".into(), Value::String(title));
            slot.insert("url".into(), Value::String(link));
            slot.insert("episode".into(), Value::String(txt(&el.select(&sel(".jr-ep-text")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 30)));
            let put = |m: &mut Map<String, Value>, k: &str, v: String| {
                if !v.is_empty() {
                    m.insert(k.into(), Value::String(v));
                }
            };
            put(&mut slot, "time", txt(&el.select(&sel(".time-text")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 20));
            put(&mut slot, "rating", num_in(&el.select(&sel(".rating-text")).next().map(|e| e.text().collect::<String>()).unwrap_or_default()));
            put(&mut slot, "members", txt(&el.select(&sel(".members-text")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 20));
            put(&mut slot, "type", txt(&el.select(&sel(".jr-type-badge")).next().map(|e| e.text().collect::<String>()).unwrap_or_default(), 20));
            put(&mut slot, "status", el.value().attr("data-status").unwrap_or("").to_string());
            if !genres.is_empty() {
                slot.insert("genres".into(), Value::Array(genres));
            }
            entries.push(Value::Object(slot));
        }
        if !entries.is_empty() {
            out.push(json!({"day": name, "dateText": txt(day.value().attr("data-date-text").unwrap_or(""), 40), "entries": entries}));
        }
    }
    Ok(Value::Array(out))
}
async fn get_top() -> Result<Value, String> {
    let all = match get_popular().await? {
        Value::Array(a) => a,
        _ => vec![],
    };
    let mut seen: HashMap<String, Value> = HashMap::new();
    let mut order: Vec<String> = vec![];
    for a in all {
        let u = a.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if u.is_empty() || seen.contains_key(&u) {
            continue;
        }
        order.push(u.clone());
        seen.insert(u, json!({
            "title": a.get("title").cloned().unwrap_or(Value::Null),
            "url": a.get("url").cloned().unwrap_or(Value::Null),
            "thumbnail": a.get("thumbnail").cloned().unwrap_or(Value::Null),
            "score": a.get("score").cloned().unwrap_or(Value::Null),
        }));
    }
    let mut out: Vec<Value> = order.into_iter().filter_map(|k| seen.remove(&k)).collect();
    out.sort_by(|a, b| {
        let ra: f64 = a.get("score").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let rb: f64 = b.get("score").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        rb.partial_cmp(&ra).unwrap()
    });
    Ok(Value::Array(out))
}
async fn get_season(season: &str, year: i64, page: i64) -> Result<Value, String> {
    let s = season.to_lowercase();
    if !["spring", "summer", "fall", "autumn", "winter"].contains(&s.as_str()) {
        return Err("Season must be spring/summer/fall/winter".into());
    }
    if year == 0 {
        return Err("Year required (e.g. season winter 2024)".into());
    }
    let y = year.clamp(1990, 2100);
    let p = clamp_page(page);
    let b = format!("{}/premiereds/{s}-{y}/", base());
    let u = if p == 1 { b } else { format!("{b}page/{p}/") };
    let cards = parse_as_cards(&doc_of(&fetch_page(&u).await?), "");
    Ok(Value::Array(
        cards
            .into_iter()
            .map(|c| {
                json!({
                    "title": c.get("title").cloned().unwrap_or(Value::Null),
                    "url": c.get("url").cloned().unwrap_or(Value::Null),
                    "thumbnail": c.get("thumbnail").cloned().unwrap_or(Value::Null),
                    "score": c.get("rating").cloned().unwrap_or(Value::String(String::new())),
                    "genre": c.get("genres").and_then(|v| v.as_array()).map(|g| g.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
                })
            })
            .collect(),
    ))
}

// === INPUT SANITIZERS ===
fn clamp_page(p: i64) -> i64 {
    p.clamp(1, 50)
}
fn clean_slug(s: &str) -> Result<String, String> {
    if s.is_empty() {
        return Err("Slug required".into());
    }
    let mut c = s.trim().to_lowercase();
    if c.len() > 80 {
        c.truncate(80);
    }
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"^[a-z0-9-]+$").unwrap());
    if !r.is_match(&c) {
        return Err("Invalid slug (a-z 0-9 - only)".into());
    }
    Ok(c)
}
fn clean_query(q: &str) -> Result<String, String> {
    if q.is_empty() {
        return Err("Query required".into());
    }
    let mut c: String = q.split_whitespace().collect::<Vec<_>>().join(" ");
    c = c.trim().to_string();
    if c.len() > 100 {
        c.truncate(100);
    }
    if c.len() < 2 {
        return Err("Query too short".into());
    }
    Ok(c)
}

// === CLI ===
fn print_usage() {
    println!(r#"
NontonAnimeID Scraper - Rust port
=================================
Usage:
  nontonanime home [page] / latest [page] / search <query> / advsearch [opts]
  nontonanime list [page] / anime <url> / episode <url> / stream <url> [n]
  nontonanime servers <url> / resolve <url> [n|name] / nav <url> / meta <url>
  nontonanime genres [az|popular|ongoing] / genre <slug> [page] / ongoing [sort]
  nontonanime popular / schedule / recent [page] / top / season <s> <y> [page]
  nontonanime more --offset=N [ids..]
"#);
}

#[tokio::main]
async fn main() {
    let mut pos: Vec<String> = vec![];
    let mut flags: HashMap<String, String> = HashMap::new();
    for a in std::env::args().skip(1) {
        if let Some(b) = a.strip_prefix("--") {
            match b.find('=') {
                None => {
                    flags.insert(b.to_string(), String::new());
                }
                Some(i) => {
                    let mut v = b[i + 1..].to_string();
                    if v.len() > 200 {
                        v.truncate(200);
                    }
                    flags.insert(b[..i].to_string(), v);
                }
            }
        } else {
            pos.push(a);
        }
    }
    let cmd = pos.first().cloned().unwrap_or_default();
    if cmd.is_empty() || cmd == "help" || cmd == "--help" {
        print_usage();
        return;
    }
    let get = |i: usize| -> String { pos.get(i).cloned().unwrap_or_default() };
    let pg = |i: usize| -> i64 { get(i).parse().map(clamp_page).unwrap_or(1) };
    let need = |i: usize, msg: &str| -> Result<String, String> {
        let v = get(i);
        if v.is_empty() {
            Err(msg.to_string())
        } else {
            Ok(v)
        }
    };
    let not_null = |v: Value, msg: &str| -> Result<Value, String> {
        if v.is_null() {
            Err(msg.to_string())
        } else {
            Ok(v)
        }
    };
    let res: Result<Value, String> = match cmd.as_str() {
        "home" => get_home(pg(1)).await,
        "latest" | "recent" => get_latest(pg(1)).await,
        "search" => search_anime(&get(1)).await,
        "advsearch" => advanced_search(&flags).await,
        "list" => get_list(pg(1)).await,
        "anime" => match need(1, "Anime URL required") {
            Ok(u) => get_anime_detail(&u).await.and_then(|v| not_null(v, "Anime not found")),
            Err(e) => Err(e),
        },
        "episode" => match need(1, "Episode URL required") {
            Ok(u) => get_episode_info(&u).await.and_then(|v| not_null(v, "Episode not found")),
            Err(e) => Err(e),
        },
        "stream" => match need(1, "Episode URL required") {
            Ok(u) => {
                let n: i64 = get(2).parse().unwrap_or(1);
                get_stream(&u, n.clamp(1, 20)).await
            }
            Err(e) => Err(e),
        },
        "servers" => match need(1, "Episode URL required") {
            Ok(u) => get_servers(&u).await,
            Err(e) => Err(e),
        },
        "resolve" => match need(1, "Episode URL required") {
            Ok(u) => {
                let s = get(2);
                resolve_server(&u, if s.is_empty() { "1" } else { &s }).await
            }
            Err(e) => Err(e),
        },
        "nav" => match need(1, "Episode URL required") {
            Ok(u) => get_nav(&u).await,
            Err(e) => Err(e),
        },
        "meta" => match need(1, "Episode URL required") {
            Ok(u) => get_meta_ep(&u).await,
            Err(e) => Err(e),
        },
        "genres" => get_genres(&get(1)).await,
        "genre" => match need(1, "Genre slug required") {
            Ok(s) => get_genre_anime(&s, pg(2)).await,
            Err(e) => Err(e),
        },
        "ongoing" => get_ongoing(&get(1)).await,
        "popular" => get_popular().await,
        "schedule" => get_schedule().await,
        "top" => get_top().await,
        "season" => match (need(1, "Season required (spring/summer/fall/winter)"), need(2, "Year required (e.g. season winter 2024)")) {
            (Ok(s), Ok(y)) => {
                let year: i64 = y.parse().unwrap_or(0);
                get_season(&s, year, pg(3)).await
            }
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        "more" => {
            let ids: Vec<i64> = pos.iter().skip(1).filter_map(|x| x.parse().ok()).collect();
            let off: i64 = flags.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
            load_more(&ids, off).await
        }
        _ => {
            eprintln!("Unknown command: {cmd}");
            print_usage();
            return;
        }
    };
    match res {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v).unwrap()),
        Err(e) => {
            eprintln!("[ERROR] {e}");
            std::process::exit(1);
        }
    }
}
