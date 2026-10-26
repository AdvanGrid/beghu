//! PROTOTYPE — runtime half: migration runners, the filter type the generated fragments build,
//! and the per-account gate that decides who waits while a mirror catches up.

pub mod filter;
pub mod gate;
pub mod migrations;

pub use migrations::{Kind, Migration};
