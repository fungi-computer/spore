# Upstream license texts omitted from npm distributions

`upstream.json` maps exact dependency versions to their repository notices,
source revisions and checksums. The bundle uses installed license files where
available; these supplements cover distributions that omit them. Most revisions
come from published VCS metadata. Where that metadata is absent, the record
explicitly identifies a pinned upstream license snapshot.

Four projects also omit a separate license file in their source repository:
TanStack Markdown, debugserver-types, eventsource-stream and fxhash. Their
`NOTICE.*` files preserve the declared license and available attribution.
Standard MIT permission terms or the offered Apache-2.0 terms accompany those
declarations; no missing copyright year or holder is fabricated. Review these
declarations as part of publication approval.

For example, `LICENSE.pi` is the unmodified root license from
[`earendil-works/pi` v1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE),
the release used by `@earendil-works/pi-ai@1.3.0`. Its SHA-256 is
`0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48`. The bundler
includes this text in `THIRD_PARTY_NOTICES` because the upstream npm package
declares MIT but does not carry the license file. It does not set the Fungi
CLI's license.
