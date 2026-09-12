# NFT storage and minting reliability

## Latest incident: #243 (12 September 2026)

The annual-storage patch `91010c3` did **not** resolve the reported incident. At 08:19:18 UTC, #243's actual image was available from the paid gateway: HTTP 200, `image/jpeg`, 35,406 bytes, 960 × 540, with an exact raw-CID SHA-256 match. Its 726-byte metadata file was registered in the paid annual account, but its on-chain metadata URL still returned HTTP 404. Consequently the marketplace cannot discover either the NFT name or its otherwise available image. Do not change image geometry to address this missing JSON.

| #243 evidence | Observation |
|---|---|
| Successful mint transaction | `0x3a1146afdbb281c0cc0ac3bf042a8d7bdf43ad5bb2f0629eac421c605d7843a3`, Base block 51205491, 08:05:29 UTC |
| First finalizer request | `l8x8r-1789200328816-e208994f3b48`, 08:05:28.816 UTC, 6.40 seconds execution, HTTP 202 |
| Deployed build | `dpl_9tSNhKJmmBubfBspC97nNM7ESVcj`, annual-storage patch |
| Request trace | Receipt RPC, two Lighthouse upload POSTs, then paid-host GETs for both exact CIDs |
| Paid account | Metadata CID listed in annual storage; `metadata.json`, 726 bytes, unencrypted |
| Image | [Exact paid image](https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs/bafkreicaelvlgvveaapgoc3amlbsj4jvql7qtk52a3qjfzjhkdnx7szczu), 200 and verified |
| Metadata | [Exact on-chain paid metadata](https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs/bafkreiav6mkurg7ujycn4cf5dl2nqhz6sd5lket25gyspvr2rxzaeousde), 404 |

At 08:21:34 UTC, the canonical metadata GET, documented `?format=raw` retrieval, and `?filename=metadata.json` all returned the same 273-byte missing-block/no-providers error, with `cf-cache-status: DYNAMIC`. This supplies no evidence for a MIME/representation-only problem. These are read-only observations, not uploads or attempts to recover an existing NFT.

The trace does **not** expose raw upload response bodies or HTTP trailers. Reaching the gateway checks proves only that the old application parser accepted both upload responses; it does not prove that those responses were free of late errors. The provider-side reason this registered metadata block is unavailable remains unknown. Do not label this an OpenSea defect, assume the annual header fixed it, or claim the response hardening below makes #243 available.

### Verified code defect and bounded correction

The previous parser discarded malformed NDJSON lines and ignored error records whenever another record contained the expected `Hash`. Kubo can also signal failure after HTTP 200 in the `X-Stream-Error` response trailer; its own client checks that trailer after reading the body.[^stream-errors] Native Fetch does not expose trailers, whereas Node's `IncomingMessage.trailers` is populated at the response's `end` event.[^trailers]

The correction rejects malformed/error records and uses an upload-only Node HTTPS transport that consumes the complete bounded response and checks actual error trailers. Merely declaring `Trailer: X-Stream-Error` is not an error. Native FormData still constructs the multipart body; filenames, MIME types, file bytes, CID/pinning query, bearer authentication and annual-storage selection stay unchanged. There is no redirect, automatic upload retry, new gateway, mint-order change or image re-encoding. Timeouts retain the existing pending response, and exact paid-byte verification remains mandatory for success.

Server-only logs now distinguish upload stage, allowlisted failure reason and HTTP status from unavailable delivery. They do not contain API keys, request packages, artwork, response bodies or arbitrary provider error messages. This is necessary operational evidence, not a substitute for resolving missing metadata.

Validation: 131 local regression tests pass, including real loopback HTTP trailers, multipart byte round trips, partial responses, timeouts, malformed JSON and image-versus-metadata failure logging. The production build and focused lint for changed code pass. Repository-wide lint still reports 61 errors and 22 warnings in untouched code. No actual Lighthouse upload, NFT mint or recovery was performed during this investigation. The corrected error recognition is verified locally; #243's metadata availability is still unresolved.

## Findings from the preceding #242 investigation

The missing name and missing image are linked failures: OpenSea needs the JSON returned by the contract's `tokenURI` before it can discover either field. Token #242 currently points to the correct paid Lighthouse host, but that metadata URL returns HTTP 404. Renaming the NFT, changing its aspect ratio, or requesting a marketplace refresh cannot supply an unavailable JSON file.[^opensea]

There are two separate reliability problems. First, the current application mints before it uploads; a successful transaction therefore does not establish successful storage. Second, #242's specific request passed the prior parser's matching-CID checks for both Lighthouse uploads, yet the paid gateway still could not retrieve the files. The first problem is established by the code. The second is established by production evidence, but the reason for accepted-but-unavailable files remains unproven.

The upload integration also omitted the documented `X-Storage-Type: annual` header. Explicit annual storage selection is a justified correction for this subscription. It is not evidence, by itself, that #242 failed because the header was absent.[^annual]

## Production evidence

Observations are from 12 September 2026. The contract is `0x6362da72665385a437910d276f5db9777a2f4edd` on Base. Delivery is restricted to `https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs`.

| Evidence | Result | Meaning |
|---|---|---|
| #237 metadata | HTTP 200, `application/json`, 728 bytes | The paid host serves a known-working metadata file |
| #237 image | HTTP 200, `image/jpeg`, 35,036 bytes, 960 × 540 | The existing landscape format works |
| #237 metadata and image hashes | Both raw CIDv1 SHA-256 digests match downloaded bytes | The flat raw-CID format is supported by this paid delivery path |
| #242 on-chain URI | Exact configured paid host | This token's failure is not an incorrect delivery hostname |
| #242 metadata | HTTP 404, `text/plain; charset=utf-8` | No readable NFT JSON at its on-chain address |
| #242 earlier image retrieval | HTTP 404 | The problem is not only marketplace indexing |
| #242 upload responses | Both passed the prior matching-CID parser | Both upload requests ran; this does not exclude unobserved late errors |
| #242 authenticated account file list | Both exact CIDs listed | Registration occurred in the intended paid account |
| #242 first finalization request | 6.93 seconds, HTTP 202 | The observed request did not exhaust the upload or overall time limit |

The #242 gateway error reported that the requested block was not locally available and no provider was found. Registration is not the same as retrieval: Lighthouse's documented file-info response describes filename, size, MIME, CID and encryption, but makes no assertion that a particular gateway currently has all required blocks.[^fileinfo]

The direct paid-gateway evidence links are [#237 metadata](https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs/bafkreibttkr6bevocgvmz6ngzrgmzczfywznx3iqu5bwkpzzyqrtc72rsy), [#237 image](https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs/bafkreido2323h3iht3xcwboiv3eiut6xdckzlztghvcuavhs6gptkgqjau), and [#242 metadata](https://protective-walrus-h5noy.lighthouseweb3.xyz/ipfs/bafkreididw2zxg2hwx3mh4nglsgfungd442b62cpavrkijqeudwjdwkihm). The account-list and execution-log observations are private production records, not publicly reproducible sources. No credentials are included here.

The older Pinata-backed items are not current storage-availability controls: their original hosted files were subsequently deleted, while their OpenSea previews remained cached. Their historical implementation is still a useful code reference. The current retrieval control above is the separately verified paid-Lighthouse #237, not a cached preview of those deleted Pinata files.

## Git snapshot comparison

The original production Pinata path and the later working Lighthouse path must not be conflated. They used different transaction ordering.

| Snapshot | Relevant behavior | Implication |
|---|---|---|
| `8b7880da` — before Pinata removal | Upload image, upload JSON, require returned URI, then call `mintRunNft` | An upload error stops the application before sending a mint transaction |
| `cd4a2d8` — #233 working reference | Local CID package, mint, successful receipt, then Lighthouse uploads; only explicit retries probe first | A working post-mint example, not evidence that every post-mint upload must succeed |
| `b393790` | Same finalizer as `cd4a2d8`; removes `background_color` | Appearance-only metadata change, not a storage algorithm change |
| `243cfcb` | Square artwork framing; sequential file uploads | Introduced a geometry change that was unnecessary for storage |
| `2e33fae` | Restores landscape framing | The correct image geometry is already present |
| `a14c52f` | Adds a gateway preprobe on every finalization and bounded deadlines | Fresh requests start by reading potentially not-yet-uploaded CIDs |
| `5e82a48` | Run-scoped mint lifecycle protection | Prevents previous-run state from controlling a fresh run |
| `f41dbc3` | Paid-only delivery | Does not add annual storage selection to upload requests |

These observations follow the exact repository snapshots, including the original [Pinata route and mint handler](https://github.com/0xmdrakib/HillClimb/tree/8b7880da850b9cedd980ec9033dd61ff80ffabc6), the [#233 reference](https://github.com/0xmdrakib/HillClimb/tree/cd4a2d86f02bccfea566499d4b755faf4523b350), and the [background-only change](https://github.com/0xmdrakib/HillClimb/commit/b3937905e7f947f2599d6a0756f57e7f5389cb04).

There is no map-specific upload implementation. `Terrain` changes a metadata attribute; Countryside, Desert, Arctic and Moon use the same package builder and finalizer. The current package builder is semantically unchanged from `b393790` for image encoding, filenames, flat CID structure, metadata name and delivery URLs. Rewriting those parts again has no demonstrated relationship to the missing #242 files.

## Current Lighthouse integration

The official upload documentation introduces `storageType: "annual"` in SDK 0.4.4. The versioned 0.4.7 implementation passes that selection as `X-Storage-Type`, uses bearer authentication, and sends multipart file content to `/api/v0/add`. Its Node implementation returns the provider response; it does not subsequently verify download availability.[^annual][^sdk]

The project's direct HTTP implementation shares that endpoint, multipart-file and bearer-authentication pattern. Its additional CID, chunker and pinning query parameters are not exercised by the cited SDK example; matching upload CIDs and the working #237 files are the project-specific evidence for that format. Adopting the entire SDK is not necessary to add the documented header. Changing CID construction or switching storage providers is likewise not justified by the fact that this option was missing. Matching the exact returned CID remains necessary because the NFT's URI was already committed on-chain.

Hot retrieval and long-term retention are separate concerns. IPFS content needs retained blocks, not just a computable address. Filecoin storage agreements and aggregation do not substitute for an HTTP retrieval check at the NFT's actual delivery URL.[^persistence]

The official Lighthouse UI repository has a May 2025 report of successful-looking uploads followed by broken download links. It remains without a maintainer diagnosis in that issue. It shows that similar symptoms have been reported, but neither proves this incident is a provider defect nor identifies a fix for annual-plan uploads.[^issue]

Community searches did not establish a current, reproducible annual-plan failure matching #242. Historical discussions about other storage providers are not a basis for changing this integration. Implementation decisions here rest on repository history, current official source and actual request evidence.

## Artwork and metadata contract

The correct artifact is the full landscape crash frame, proportionally encoded as JPEG, capped at 960 × 540, using quality 0.9. No square canvas, crop, filled padding, image-generation step or gameplay change is required. JPEG quality 0.9 is lossy compression, not a claim of mathematical losslessness.

The metadata keeps `name`, `description`, a paid HTTPS `image` URL and the six run traits. The on-chain URI must address that JSON, not the JPEG or a CAR transport container. OpenSea supports HTTPS metadata storage; its schema also recognizes `background_color`, which affects presentation rather than changing the encoded image pixels.[^storage][^media]

IPFS documentation recommends provider-independent IPFS URIs for portability. This project intentionally uses its paid HTTPS host for primary delivery, with content-addressed provenance retained in metadata. That choice is supported by OpenSea, but availability remains dependent on the configured host. It must not silently switch to another delivery service.[^ipfs][^storage]

## Transaction ordering and the required decision

The original application and Lighthouse's NFT tutorial both put storage before minting.[^tutorial] Adding exact paid-gateway verification to that ordering produces:

`local capture → authenticated upload → verify image + JSON → wallet mint → confirmed NFT`

This stops the application from minting a known-unavailable URI. A provider outage during preparation becomes a preparation error before any mint gas is spent. It does not guarantee that the provider can never become unavailable later. The existing unrestricted contract can also be called outside the application, so application validation is not an on-chain enforcement guarantee.

The tradeoff is substantive: if the wallet transaction is subsequently rejected, the already-uploaded files exist on IPFS. Deleting an account registration later cannot guarantee erasure of distributed copies. Therefore this ordering cannot silently replace the current rule that canceled transactions upload nothing.

The current ordering preserves that cancellation rule:

`local capture → wallet mint → successful receipt → upload → verify image + JSON`

But it necessarily allows a minted token to exist before its files are available. A browser interruption in that interval can prevent the upload altogether. IndexedDB retries help an interrupted browser resume; they are not a durable backend job and cannot ensure work continues after local data loss.

Keeping zero IPFS uploads for canceled transactions while removing browser dependence requires durable server-side staging and a chain-driven job. A separately designed two-phase contract could also change the commit/finalization boundary, but it would still need durable pending bytes and a worker; a contract alone does not provide those. These are additional infrastructure or contract decisions, not an image-size adjustment. They still need explicit delivery-failure handling. A single existing-contract mint transaction cannot atomically commit an external Lighthouse upload.

The recommended simple application flow is storage-and-verification before mint, contingent on explicitly accepting its canceled-transaction storage tradeoff. No such workflow change is implemented in the accompanying bounded patch.

Pre-mint preparation must not be a direct restoration of the old anonymously callable upload route. The current receipt requirement is an authorization and abuse-cost gate, not merely an ordering choice. Replacing it requires a narrowly scoped wallet-signed upload intent, expiry and replay controls, strict package validation and service-wide storage quotas. The existing rate-limit implementation only shares counters within a warm server instance; it is not a distributed quota. A wallet signature proves control of a wallet, not that the submitted image came from genuine gameplay. These limits must remain explicit rather than promising that an arbitrary caller cannot ever misuse an exposed preparation endpoint.

## Bounded patch and remaining evidence gap

The accompanying code correction is restricted to the upload finalizer and its shared gateway configuration:

1. Select annual storage explicitly for both image and metadata uploads.
2. Restore the reference finalizer's fresh-upload-before-probe ordering, still after receipt verification. Retries retain their initial existing-file check.
3. Reject redirects rather than silently following another host.
4. Require JSON/JPEG MIME types and exact retrieved bytes before returning verified success.
5. Restrict configured delivery URLs to dedicated HTTPS Lighthouse hosts under `/ipfs`, rejecting credentials, custom ports and extra URL parts. Previously, the shared helper accepted any HTTPS host despite the stated paid-only policy; an inherited incorrect environment setting could therefore bypass that policy. Invalid settings now fall back to the project's supplied paid host. This is a preventive correction, not the observed cause of #242, whose URI already used the right host.

Receipt validation, CAR block verification, request limits, the project's existing paid URLs, NFT naming, capture geometry, wallet behavior and game logic remain unchanged. Removing a fresh preprobe avoids unnecessary early missing-file reads; there is no evidence that such reads caused negative caching in #242. Strict validation prevents false success but cannot itself make missing provider blocks available. The README's stale delivery instructions and environment-example comments are corrected to describe the actual paid-only integration and optional marketplace refresh key.

The local regression suite passes 69 tests and the production build passes. Coverage includes all four map metadata values, wrong CIDs, missing files, unexpected MIME types, redirects, canceled/reverted transactions, retry ordering, run isolation and invalid gateway configurations. Provider responses and browser canvas encoding are controlled in these tests; they do not prove a new real Lighthouse upload is deliverable or a new OpenSea item is indexed.

`scripts/verify-nft-delivery.mjs` supplies a read-only check from on-chain URI to JSON name to JPEG bytes and dimensions. For current raw SHA-256 CIDs it verifies the content hash. Older UnixFS DAG roots are explicitly marked as not hash-verified by that helper rather than falsely compared to a flat-file digest. Its existing-token result is currently **#237 passes; #242 fails at paid metadata HTTP 404**.

The remaining gap is not another font, map or aspect-ratio change: it is successful delivery of a newly accepted upload under the corrected annual integration, and a decision about whether storage must precede minting. Existing missing NFTs are separate incidents; this patch neither recovers them nor rewrites their immutable URIs.

## Sources

[^opensea]: OpenSea, [Metadata standards](https://docs.opensea.io/docs/metadata-standards), current documentation, accessed 12 September 2026. Defines `tokenURI`, JSON name, media and traits.
[^annual]: Lighthouse, [Upload Data](https://docs.lighthouse.storage/how-to/upload-data/), current documentation, accessed 12 September 2026. Documents annual storage header support introduced in SDK 0.4.4.
[^sdk]: Lighthouse, [versioned Node file uploader](https://github.com/lighthouse-web3/lighthouse-package/blob/9b35c67d7f1aa8a2f8827c40e6e68b8ece83bb79/src/Lighthouse/upload/files/node.ts), SDK 0.4.7 source commit `9b35c67d`, accessed 12 September 2026. Multipart endpoint, authentication and storage header behavior.
[^fileinfo]: Lighthouse, [File Info](https://docs.lighthouse.storage/how-to/file-info), current documentation, accessed 12 September 2026. Registration fields, not a download-availability assertion.
[^persistence]: IPFS, [Persistence, permanence, and pinning](https://docs.ipfs.tech/concepts/persistence/), accessed 12 September 2026. Retention, pinning, hot retrieval and Filecoin storage distinction.
[^issue]: GitHub user `barbaraperic`, Lighthouse UI [issue #11: File System Failures — Upload Errors and Non-functional Download Links](https://github.com/lighthouse-web3/lighthouse-ui/issues/11), opened 14 May 2025. Historical firsthand report only; no established incident-specific cause or fix.
[^storage]: OpenSea, [Metadata storage](https://docs.opensea.io/docs/metadata-storage), current documentation, accessed 12 September 2026. HTTPS metadata support.
[^media]: OpenSea, [Media and traits](https://docs.opensea.io/docs/media-and-traits), current documentation, accessed 12 September 2026. Image and background-color fields.
[^ipfs]: IPFS, [Best practices for storing NFT data using IPFS](https://docs.ipfs.tech/how-to/best-practices-for-nft-data/), accessed 12 September 2026. Content addressing, portability and metadata structure. Its JavaScript examples are explicitly marked outdated; they are not implementation templates for this patch.
[^tutorial]: Lighthouse, [Minting NFTs on EVM Chains](https://docs.lighthouse.storage/tutorials/minting-nfts-on-evm-chains), accessed 12 September 2026. Image and metadata upload precede minting. The tutorial contains legacy testnet and library examples; only its storage ordering and metadata relationship are applicable here.
[^stream-errors]: IPFS, [Kubo RPC response semantics](https://docs.ipfs.tech/reference/kubo/rpc/), and official [response emitter](https://github.com/ipfs/go-ipfs-cmds/blob/master/http/responseemitter.go) / [response reader](https://github.com/ipfs/go-ipfs-cmds/blob/master/http/response.go), accessed 12 September 2026. Streaming HTTP 200 can be followed by a late error trailer.
[^trailers]: Node.js, [IncomingMessage.trailers](https://nodejs.org/api/http.html#messagetrailers), and WHATWG, [Fetch Response interface](https://fetch.spec.whatwg.org/#response-class), accessed 12 September 2026.
