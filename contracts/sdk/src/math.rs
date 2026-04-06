//! Numeric utility functions — checked arithmetic, basis-point helpers,
//! integer square-root (Babylonian method).

/// Checked addition for `i128`, returning `None` on overflow.
#[inline]
pub fn checked_add(a: i128, b: i128) -> Option<i128> {
    a.checked_add(b)
}

/// Checked subtraction for `i128`, returning `None` on underflow.
#[inline]
pub fn checked_sub(a: i128, b: i128) -> Option<i128> {
    a.checked_sub(b)
}

/// Checked multiplication for `i128`, returning `None` on overflow.
#[inline]
pub fn checked_mul(a: i128, b: i128) -> Option<i128> {
    a.checked_mul(b)
}

/// Checked division for `i128`, returning `None` when `b == 0`.
#[inline]
pub fn checked_div(a: i128, b: i128) -> Option<i128> {
    a.checked_div(b)
}

/// Apply a basis-point multiplier: `value * bps / 10_000`.
///
/// Returns `None` on overflow.
#[inline]
pub fn apply_bps(value: i128, bps: i128) -> Option<i128> {
    value.checked_mul(bps)?.checked_div(10_000)
}

/// Compute the fee portion in basis points: `amount * fee_bps / 10_000`.
#[inline]
pub fn fee_bps(amount: i128, bps: i128) -> Option<i128> {
    apply_bps(amount, bps)
}

/// Convert via an oracle rate scaled to 1e7:
/// `amount_out = amount_in * rate / 10_000_000`.
#[inline]
pub fn convert_rate(amount_in: i128, rate: i128) -> Option<i128> {
    amount_in.checked_mul(rate)?.checked_div(10_000_000)
}

/// Integer square root via the Babylonian (Newton) method.
///
/// Returns the largest `r` such that `r * r <= n`.
pub fn isqrt(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    if n == 1 {
        return 1;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Price-impact in basis points:
/// `impact_bps = (spot_out - actual_out) * 10_000 / spot_out`.
pub fn price_impact_bps(spot_out: i128, actual_out: i128) -> Option<i128> {
    if spot_out == 0 {
        return Some(0);
    }
    let diff = spot_out.checked_sub(actual_out)?;
    diff.checked_mul(10_000)?.checked_div(spot_out)
}

/// Compute a daily reward from an annual APY expressed in basis points:
/// `daily = amount * apy_bps / 10_000 / 365`.
#[inline]
pub fn daily_reward(amount: i128, apy_bps: i128) -> Option<i128> {
    amount.checked_mul(apy_bps)?.checked_div(10_000)?.checked_div(365)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_isqrt() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(9), 3);
        assert_eq!(isqrt(10), 3);
        assert_eq!(isqrt(1_000_000), 1_000);
    }

    #[test]
    fn test_apply_bps() {
        // 50 % of 200
        assert_eq!(apply_bps(200, 5000), Some(100));
        // 0.3 % fee (30 bps) on 10 000
        assert_eq!(fee_bps(10_000, 30), Some(30));
    }

    #[test]
    fn test_price_impact() {
        assert_eq!(price_impact_bps(1000, 990), Some(100)); // 1 %
    }

    #[test]
    fn test_daily_reward_calc() {
        // 1 000 tokens at 10 % APY → ~2 per day (truncated)
        assert_eq!(daily_reward(1_000, 1_000), Some(0)); // 1000*1000/10000/365 = 0 (integer)
        assert_eq!(daily_reward(1_000_000, 1_000), Some(273)); // 1e6*1000/10000/365 = 273
    }
}
