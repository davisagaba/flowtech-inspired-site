# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: South African trade and commercial buyers — contractors, facilities managers, and small-to-mid businesses — requesting quotes for washroom automation and sanitaryware (hand dryers, automatic taps, soap dispensers, sensor flushers, urinals, entrance automation, accessories), typically via WhatsApp or the website's quote form, often for bulk/project quantities. Secondary: individual homeowners buying single items.

Staff users: Life Style Ceramics sales/admin staff who work inbound quote requests, issue formal numbered quotations, track client replies and email correspondence, manage stock, and communicate with clients over WhatsApp and email — all through the admin panel built alongside the storefront.

## Product Purpose

An e-commerce storefront (lyfestyleceramics.co.za) paired with a staff-facing admin CRM. The storefront lets clients browse the catalog and submit quote requests (cart-based or WhatsApp-initiated via pre-filled deep links). The admin panel turns each request into a numbered, typeset formal quotation (PDF, format `LC-QT-YYYY-MM-NNNN`), tracks its lifecycle (draft → issued → sent, with read-receipt and reply tracking), and gives staff a single place to manage clients, stock, mailbox, and documents. Success means a client's request becomes an accurate, professional quotation in staff's hands fast, with nothing falling through the cracks (duplicate flags, auto-refresh, automated backups all exist to prevent silent data loss or missed leads).

## Positioning

Faster, more personal service than a typical sanitaryware/washroom-automation supplier: every quote is reviewed and confirmed by a real staff member (not a fully automated bot), with fast turnaround and direct WhatsApp/email access to a person — deliberately not a self-service-only or automated-pricing experience.

## Operating Context

- Storefront pricing is stored as a GBP base price per product, converted to VAT-inclusive ZAR at a fixed rate for display; formal quotations unwind VAT to show it as a separate line.
- Staff work primarily inside the admin panel (Dashboard, Quote Requests, Formal Quotations, Clients, Quick Quote Link, Email, Products/Stock, Documents, Settings, Activity Log).
- WhatsApp is a first-class channel: staff use a "Quick Quote Link" tool to pre-fill the public quote form with a client's name/phone/items for sharing over WhatsApp, and a bookmarklet to pull a contact's name/number straight from an open WhatsApp Web chat. A manual (non-automated) numbered opening menu exists for staff to send at the start of a WhatsApp conversation.
- Numbered formal-quotation documents are never reused once issued (void instead of delete), to preserve document-number integrity for accounting/audit purposes.
- Data (formal quotes, quote-request log, products, etc.) is backed up automatically every 6 hours via a VPS cron job, with the last 60 snapshots retained.

## Capabilities and Constraints

- Backend: Node.js/Express on a Hostinger VPS, nginx reverse proxy, deployed via scp (no CI/CD pipeline — manual deploy + `systemctl restart`).
- Data persistence is flat JSON/JSONL files on disk (no database), with dedicated endpoints per concern (products, formal-documents, quote-requests log, settings, users).
- Auth: shared or per-user password login for the admin panel (no OAuth/SSO).
- Email: IMAP/SMTP against the business's own mailbox (not a transactional email service), with open-tracking pixels and reply-detection by matching doc numbers in subject lines.
- No WhatsApp Business API / automation is in use — all WhatsApp interaction is manual, via `wa.me` deep links staff click themselves.
- Standing defaults exist for several formal-quotation fields (Account, VAT Reg No, Ref No, Account Rep, 10% discount) so issuing a quote never blocks on missing data.

## Brand Commitments

- Name: Life Style Ceramics (storefront/brand) / LIFESTYLE CERAMICS (PTY) LTD (legal entity on formal documents).
- Domain: lyfestyleceramics.co.za.
- Formal documents carry fixed legal details (VAT reg no, company reg no, registered address, landline) and a fixed "Created By / Last Operator" name regardless of which staff account is logged in.

## Evidence on Hand

- Real historical client quote requests and formal quotations (various products, predominantly washroom automation and sanitaryware) processed through the live system.
- Real client email replies to sent quotations, used to validate the reply-tracking feature.

## Product Principles

1. A quote request must never be silently lost or duplicated without staff noticing — surfaced via duplicate/rapid-duplicate flags, auto-refresh, and automated backups.
2. Every price and quantity shown to a client must trace back to real catalog data, not free text (the generic quote form requires picking an actual stocked product).
3. Formal, numbered documents are immutable once issued; corrections happen through controlled edit paths (Edit Reference) or void-and-reissue, never silent overwrites.
4. Staff should never have to leave the admin panel to piece together a client's history — quotes, emails, and notes live together per client.
5. WhatsApp workflows reduce staff typing/manual lookup, but intentionally stop short of full automation — a real person reviews and sends every message.

## Accessibility & Inclusion

No product-specific accessibility requirement has been established; standard semantic HTML is used throughout but no formal WCAG conformance target has been confirmed.
