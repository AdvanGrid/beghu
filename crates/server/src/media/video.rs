//! A video's frame size from its first bytes, as `imagesize` reads an image's: WebM (Matroska)
//! and MP4/QuickTime, the formats GitHub takes uploads in. So a video's box is reserved before it
//! loads, as an image's is. No crate reads just this much: the readers there are for whole files.
//!
//! - WebM: `Segment` → `Tracks` → `TrackEntry` → `Video` → `PixelWidth` and `PixelHeight`.
//! - MP4: `moov` → `trak` → `tkhd`'s width and height (16.16 fixed point), the first track that
//!   has a size. Found only when `moov` comes first in the file (a "fast start" file, which
//!   GitHub's own player needs too); otherwise the size stays unknown.
//!
//! Every read is bounded by the bytes given, and a malformed file gives `None`.

/// The frame size in `head`, the first bytes of a WebM or MP4 file.
pub fn size(head: &[u8]) -> Option<(i64, i64)> {
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        webm(head, 0)
    } else if head.get(4..8) == Some(b"ftyp") {
        mp4(head, 0)
    } else {
        None
    }
}

/// An EBML element id (marker bits kept), and its length in bytes.
fn ebml_id(b: &[u8]) -> Option<(u32, usize)> {
    let first = *b.first()?;
    let len = first.leading_zeros() as usize + 1;
    if len > 4 || b.len() < len {
        return None;
    }
    Some((
        b[..len].iter().fold(0u32, |a, x| (a << 8) | u32::from(*x)),
        len,
    ))
}

/// An EBML size (marker bit dropped), and its length in bytes; `None` for an unknown size.
fn ebml_size(b: &[u8]) -> Option<(Option<u64>, usize)> {
    let first = *b.first()?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || b.len() < len {
        return None;
    }
    let mask = if len == 8 { 0 } else { 0xffu8 >> len };
    let v = b[1..len]
        .iter()
        .fold(u64::from(first & mask), |a, x| (a << 8) | u64::from(*x));
    let unknown = v == (1u64 << (7 * len)) - 1;
    Some(((!unknown).then_some(v), len))
}

const SEGMENT: u32 = 0x1853_8067;
const TRACKS: u32 = 0x1654_ae6b;
const TRACK_ENTRY: u32 = 0xae;
const VIDEO: u32 = 0xe0;
const PIXEL_WIDTH: u32 = 0xb0;
const PIXEL_HEIGHT: u32 = 0xba;
const CLUSTER: u32 = 0x1f43_b675;

/// Walks the elements in `b`, `depth` containers deep, for the first video track's size.
fn webm(b: &[u8], depth: usize) -> Option<(i64, i64)> {
    let (mut at, mut w, mut h) = (0, None, None);
    while at < b.len() && depth < 8 {
        let (id, il) = ebml_id(&b[at..])?;
        let (len, sl) = ebml_size(&b[at + il..])?;
        let start = at + il + sl;
        let end = len.map_or(b.len(), |n| (start as u64 + n).min(b.len() as u64) as usize);
        let body = b.get(start..end)?;
        match id {
            SEGMENT | TRACKS | TRACK_ENTRY | VIDEO => {
                if let Some(found) = webm(body, depth + 1) {
                    return Some(found);
                }
            }
            PIXEL_WIDTH => w = uint(body),
            PIXEL_HEIGHT => h = uint(body),
            // Frames from here on: no track comes after them.
            CLUSTER => return None,
            _ => {}
        }
        if let (Some(w), Some(h)) = (w, h) {
            return (w > 0 && h > 0).then_some((w, h));
        }
        // An element of unknown size that isn't a container runs to the end: nothing follows it.
        len?;
        at = end;
    }
    None
}

fn uint(b: &[u8]) -> Option<i64> {
    (1..=4)
        .contains(&b.len())
        .then(|| b.iter().fold(0i64, |a, x| (a << 8) | i64::from(*x)))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Walks the boxes in `b` for the first track header with a size.
fn mp4(b: &[u8], depth: usize) -> Option<(i64, i64)> {
    let mut at = 0;
    while at + 8 <= b.len() && depth < 6 {
        let size = be32(b, at)? as usize;
        let kind = b.get(at + 4..at + 8)?;
        let (header, size) = match size {
            0 => (8, b.len() - at),
            1 => {
                let large = u64::from(be32(b, at + 8)?) << 32 | u64::from(be32(b, at + 12)?);
                (16, usize::try_from(large).ok()?)
            }
            n => (8, n),
        };
        if size < header {
            return None;
        }
        let end = (at + size).min(b.len());
        let body = b.get(at + header..end)?;
        match kind {
            b"moov" | b"trak" => {
                if let Some(found) = mp4(body, depth + 1) {
                    return Some(found);
                }
            }
            b"tkhd" => {
                // Version 1 has 64-bit times: 12 more bytes before the size.
                let at = if body.first() == Some(&1) { 88 } else { 76 };
                let (w, h) = (be32(body, at)? >> 16, be32(body, at + 4)? >> 16);
                if w > 0 && h > 0 {
                    return Some((i64::from(w), i64::from(h)));
                }
            }
            _ => {}
        }
        at = end;
    }
    None
}
