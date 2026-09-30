use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use tokio::sync::Mutex;

use crate::AppState;

const AUTH_WINDOW: Duration = Duration::from_secs(60);
const AUTH_MAX_PER_WINDOW: usize = 10;

pub type RateLimitState = Arc<Mutex<HashMap<IpAddr, VecDeque<Instant>>>>;

pub fn new_state() -> RateLimitState {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Prune the map every 5 minutes so IPs that stop hitting us don't accumulate.
pub async fn run_cleanup(state: RateLimitState) {
    let mut tick = tokio::time::interval(Duration::from_secs(300));
    loop {
        tick.tick().await;
        let cutoff = Instant::now().checked_sub(AUTH_WINDOW);
        let Some(cutoff) = cutoff else { continue };
        let mut map = state.lock().await;
        map.retain(|_, deque| {
            while let Some(front) = deque.front() {
                if *front < cutoff {
                    deque.pop_front();
                } else {
                    break;
                }
            }
            !deque.is_empty()
        });
    }
}

/// True when the server runs behind a reverse proxy that appends the real
/// client address to `X-Forwarded-For`. Opt-in: without a proxy, clients could
/// forge the header to dodge the limiter.
fn trust_proxy() -> bool {
    matches!(
        std::env::var("TRUST_PROXY").as_deref(),
        Ok("true") | Ok("1")
    )
}

/// Resolves the address to rate-limit on. Behind a trusted proxy every
/// connection comes from the proxy itself, so use the right-most
/// `X-Forwarded-For` entry — the one the proxy appended, which the client
/// cannot spoof. Falls back to the peer address.
fn client_ip(
    connect: Option<SocketAddr>,
    headers: &HeaderMap,
    trust_proxy: bool,
) -> Option<IpAddr> {
    if trust_proxy {
        let forwarded = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .filter_map(|ip| ip.trim().parse::<IpAddr>().ok())
            .next_back();
        if forwarded.is_some() {
            return forwarded;
        }
    }
    connect.map(|s| s.ip())
}

/// Per-IP sliding-window limiter applied to the /auth/* routes. Caps each IP at
/// AUTH_MAX_PER_WINDOW requests per AUTH_WINDOW. Argon2id already slows brute
/// force, but this keeps a single host from monopolising CPU on the login path.
///
/// Disabled when TEST_MODE is set so integration tests (which reuse a single
/// server and can issue many auth requests quickly from 127.0.0.1) are not
/// inadvertently rate-limited.
pub async fn auth_rate_limit(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if crate::is_test_mode() {
        return Ok(next.run(req).await);
    }
    let connect = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0);
    let Some(ip) = client_ip(connect, req.headers(), trust_proxy()) else {
        return Ok(next.run(req).await);
    };

    let now = Instant::now();
    let cutoff = now.checked_sub(AUTH_WINDOW).unwrap_or(now);

    {
        let mut map = state.rate_limit.lock().await;
        let entry = map.entry(ip).or_default();
        while let Some(front) = entry.front() {
            if *front < cutoff {
                entry.pop_front();
            } else {
                break;
            }
        }
        if entry.len() >= AUTH_MAX_PER_WINDOW {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        entry.push_back(now);
    }

    Ok(next.run(req).await)
}

#[cfg(test)]
mod tests {
    use super::client_ip;
    use axum::http::HeaderMap;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn peer() -> Option<SocketAddr> {
        Some(SocketAddr::from((Ipv4Addr::new(127, 0, 0, 1), 3000)))
    }

    fn forwarded(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", value.parse().unwrap());
        headers
    }

    #[test]
    fn client_ip_uses_peer_address() {
        let ip = client_ip(peer(), &HeaderMap::new(), false);
        assert_eq!(ip, Some(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
    }

    #[test]
    fn client_ip_ignores_forwarded_header_unless_trusted() {
        let ip = client_ip(peer(), &forwarded("203.0.113.9"), false);
        assert_eq!(ip, Some(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
    }

    #[test]
    fn client_ip_uses_rightmost_forwarded_entry_when_trusted() {
        // Left entries are client-supplied and spoofable; the proxy appends last.
        let ip = client_ip(peer(), &forwarded("1.2.3.4, 203.0.113.9"), true);
        assert_eq!(ip, Some(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9))));
    }

    #[test]
    fn client_ip_falls_back_to_peer_when_header_missing() {
        let ip = client_ip(peer(), &HeaderMap::new(), true);
        assert_eq!(ip, Some(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
    }
}
