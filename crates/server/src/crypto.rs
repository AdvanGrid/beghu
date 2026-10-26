//! Keys derived from `BEGHU_TOKEN_KEY` with HKDF-SHA256, AES-256-GCM sealing, and the random
//! values and hashes sign-in needs.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use rand::RngCore as _;
use sha2::{Digest as _, Sha256};

const NONCE: usize = 12;

/// One AES-256-GCM key. A sealed blob is the 12-byte random nonce, then the ciphertext and tag.
/// `aad` (associated data) binds a blob to its context: it isn't stored, and a blob opens only
/// with the same `aad` it was sealed with.
pub struct SealKey(Aes256Gcm);

impl SealKey {
    fn derive(master: &[u8], info: &str) -> SealKey {
        let mut key = [0u8; 32];
        hkdf::Hkdf::<Sha256>::new(None, master)
            .expand(info.as_bytes(), &mut key)
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        SealKey(Aes256Gcm::new(&key.into()))
    }

    pub fn seal(&self, aad: &[u8], plain: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; NONCE];
        rand::rng().fill_bytes(&mut nonce);
        let mut out = nonce.to_vec();
        out.extend(
            self.0
                .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
                .expect("AES-GCM encryption of an in-memory buffer can't fail"),
        );
        out
    }

    /// `None` when the blob wasn't sealed with this key and `aad`, or was tampered with.
    pub fn open(&self, aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < NONCE {
            return None;
        }
        let (nonce, ct) = sealed.split_at(NONCE);
        self.0
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad })
            .ok()
    }
}

pub struct Keys {
    /// Encrypts GitHub user tokens at rest in the control DB, bound to their account (see
    /// `tokens::aad`).
    pub tokens: SealKey,
    /// Seals the sign-in state cookie (`state`, the PKCE verifier and `next`).
    pub sign_in: SealKey,
}

impl Keys {
    pub fn derive(master: &[u8]) -> Keys {
        Keys {
            tokens: SealKey::derive(master, "beghu token encryption v1"),
            sign_in: SealKey::derive(master, "beghu sign-in state v1"),
        }
    }
}

/// `n` random bytes as unpadded base64url.
pub fn random_token(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::rng().fill_bytes(&mut buf);
    b64(&buf)
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .ok()
}

pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

/// The PKCE S256 challenge for `verifier`.
pub fn pkce_challenge(verifier: &str) -> String {
    b64(&sha256(verifier.as_bytes()))
}
