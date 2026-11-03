// Respawn policy for a server the app started. Pure so it can be tested: the loop
// in main.rs feeds it each exit and does what it says. Mirrors launchd's KeepAlive
// throttling — back off between respawns, and stop for good if the server can't
// stay up (a boot-time crash would otherwise loop forever).
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);
const MAX_EXITS_IN_WINDOW: usize = 5;
const BASE_DELAY: Duration = Duration::from_secs(1);
const MAX_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
pub enum Decision {
    Respawn(Duration),
    GiveUp,
}

#[derive(Default)]
pub struct History {
    exits: Vec<Instant>,
}

impl History {
    // Record an exit and decide what to do. `ran_for` is how long that run lasted:
    // a run that survived a full window was healthy, so earlier exits are forgotten.
    pub fn on_exit(&mut self, now: Instant, ran_for: Duration) -> Decision {
        if ran_for >= WINDOW {
            self.exits.clear();
        }
        self.exits.retain(|t| now.duration_since(*t) < WINDOW);
        self.exits.push(now);
        let n = self.exits.len();
        if n >= MAX_EXITS_IN_WINDOW {
            return Decision::GiveUp;
        }
        let delay = BASE_DELAY.saturating_mul(1 << (n - 1));
        Decision::Respawn(delay.min(MAX_DELAY))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn first_exit_respawns_after_the_base_delay() {
        let mut h = History::default();
        assert_eq!(h.on_exit(Instant::now(), secs(300)), Decision::Respawn(secs(1)));
    }

    #[test]
    fn rapid_exits_back_off_then_give_up() {
        let mut h = History::default();
        let t0 = Instant::now();
        assert_eq!(h.on_exit(t0, secs(1)), Decision::Respawn(secs(1)));
        assert_eq!(h.on_exit(t0 + secs(2), secs(1)), Decision::Respawn(secs(2)));
        assert_eq!(h.on_exit(t0 + secs(5), secs(1)), Decision::Respawn(secs(4)));
        assert_eq!(h.on_exit(t0 + secs(10), secs(1)), Decision::Respawn(secs(8)));
        assert_eq!(h.on_exit(t0 + secs(20), secs(1)), Decision::GiveUp);
    }

    #[test]
    fn a_healthy_run_forgets_earlier_crashes() {
        let mut h = History::default();
        let t0 = Instant::now();
        for i in 0..4 {
            h.on_exit(t0 + secs(i), secs(1));
        }
        // Stayed up for a full window before exiting (e.g. a board-initiated restart).
        assert_eq!(h.on_exit(t0 + secs(200), secs(190)), Decision::Respawn(secs(1)));
    }

    #[test]
    fn exits_spread_out_over_time_never_give_up() {
        let mut h = History::default();
        let t0 = Instant::now();
        for i in 0..20 {
            // One exit every 40s of a 30s run: never 5 inside one 60s window.
            assert!(matches!(h.on_exit(t0 + secs(i * 40), secs(30)), Decision::Respawn(_)));
        }
    }

    #[test]
    fn delay_is_capped() {
        // Not reachable via on_exit (it gives up at 5), but the cap must hold if the
        // limits are ever raised.
        assert_eq!(BASE_DELAY.saturating_mul(1 << 10).min(MAX_DELAY), MAX_DELAY);
    }
}
