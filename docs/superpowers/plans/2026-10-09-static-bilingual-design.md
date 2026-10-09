# Static delivery and English support

The reader receives pre-rendered Korean or English HTML from a separate private S3 site bucket through CloudFront OAC. Existing API/RSS and visitor requests continue through the protected ALB and private Fargate. Keep the existing VPC, subnets, NAT and routing.

Publish compact language-specific catalogs, complete content-addressed detail JSON, complete lazy search indexes, pre-rendered list and entry HTML, and the compiled frontend assets. Upload immutable dependencies before replacing mutable pages and catalogs. Each page embeds only public bootstrap data; a detail page embeds its detail, while a listing embeds its compact catalog. Failed publication leaves the previous working dependencies accessible. Use conditional control writes and source snapshot checks so an older build cannot silently overwrite newer data. Assets and content-addressed objects are immutable; entry HTML and catalogs revalidate within 60 seconds.

The Korean inventory and all stable IDs remain unchanged. English uses every extracted official source item, presented as official English wording rather than an AI explanation. The two languages share a reader revision derived from the existing Korean public content fingerprint, so switching languages does not erase read status. The initial feed omits full item arrays and secondary explanation text. Search fetches a separate complete text index on demand and never silently searches only the visible cards. Saved Markdown export resolves all selected details before download.

The browser retains a bounded cache keyed by immutable detail URL, merges current checking metadata from the catalog, coalesces concurrent requests, prefetches only cards approaching the viewport with at most two concurrent requests, and respects reduced-data/offline/hidden-tab states. Language selection is in the top bar, persists locally, updates document language and share URLs, and covers controls, state messages, dates, RSS/export and complete detail content. Existing Korean API endpoints remain compatible.

Use 07:00 Asia/Seoul for the daily schedule and every current schedule display. Version 1.3.0 is a compatible feature release; synchronize package/lock and bilingual app-release entries. Do not create a remote tag or hosted release. Model remains Haiku 5.5 for Korean generation. No authored Korean em dashes or middle dots.

## Delivery contract

`FeedEntry` receives optional `language: ko|en`, `contentKind: explanation|source`, `readRevision: string` (legacy 16-hex fingerprint), `detailUrl: string`, `detailBytes: number`, `changeSummary: {status, sourceCount, readyCount}` and `searchText: string`. Summary records omit `fullChanges` and use a compact explanation with title/summary/category/impact and empty secondary fields. Details contain the full valid list. `Feed` adds optional `language` and `searchUrl` and permits numeric schedule hours (production 7).

`/content/{ko|en}/feed.json` is the current compact catalog. Immutable detail and search files live under `/content/objects/<sha256>.json`. Search JSON is `{language, entries: [{id,text}]}`. Listing and entry documents are `/pages/{ko|en}/index.html` and `/pages/{ko|en}/<id>.html`. CloudFront rewrites existing root query links to these S3 keys. `<template id="code-pulse-bootstrap">` contains escaped JSON `{language, feed?, detail?}`. The frontend seeds remote data from this template before its first render. The SSR root is replaced only with ready bootstrap-backed content.

## Deployment

First provision the site bucket, writer permissions and new task image with static routing disabled. Build and publish all 616 current records in both languages and verify objects before enabling CloudFront S3 routing. Run the production collector and verify that final collection publishes the static site automatically, source failures retain previous content, and the real daily schedule is 07:00. Record measured production payload, paint and detail-navigation results before and after under the same browser/network conditions.
