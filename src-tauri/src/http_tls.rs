//! Shared construction of outgoing HTTP clients.
//!
//! reqwest 0.13's `rustls` feature verifies server certificates through
//! rustls-platform-verifier. On Android that verifier performs JNI calls into
//! the `rustls:rustls-platform-verifier` Kotlin library; whenever that
//! component is missing, stale, or fails to initialize at runtime, *every*
//! HTTPS request fails before reaching the network with "error sending
//! request" — even for hosts the device can reach.
//!
//! Model, preset and Immich clients only ever talk to public-CA hosts
//! (HuggingFace, GitHub and their mirrors), so on Android they verify against
//! the bundled Mozilla root store (`webpki-roots`) instead of the platform
//! verifier. Desktop platforms keep the platform verifier, which also honors
//! OS-managed trust, user-installed CAs and corporate proxies.

/// Returns a client builder with working TLS on every platform.
pub(crate) fn base_builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();

    #[cfg(target_os = "android")]
    let builder = {
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(provider.into())
            .with_safe_default_protocol_versions()
            .expect("the rustls default protocol versions are always supported")
            .with_root_certificates(roots)
            .with_no_client_auth();
        builder.use_preconfigured_tls(config)
    };

    builder
}
