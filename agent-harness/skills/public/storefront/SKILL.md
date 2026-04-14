---
name: storefront
description: "Create a product/service storefront page for a seller. The agent builds the page from a conversation — no code needed by the user. Deploys to CF Pages for a live URL. Registers in A2A marketplace for agent discovery. Use when a user wants to sell a product, offer a service, or create a business page."
when_to_use: "When the user says they want to sell something, create a store, list a product, offer a service, or set up a business page."
category: commerce
version: 1.0.0
enabled: true
allowed-tools:
  - read
  - write
  - edit
  - list
  - find
  - grep
  - delete
  - gitInit
  - gitAdd
  - gitCommit
  - gitPush
  - gitRemote
  - web-search
  - memory-save
  - set_context
---

# Storefront Builder

Build a live product/service page from a conversation. The user describes what they sell — you build, deploy, and register it. No code knowledge required.

## How It Works

The user is a seller. They want a page for their product or service. You:
1. **Interview** — ask what they sell, price, photos, shipping, contact
2. **Build** — create a beautiful product page using HTML/CSS/JS
3. **Deploy** — push to CF Pages for a live URL
4. **Register** — save to A2A marketplace for agent discovery

## Phase 1: Interview (2-3 questions max)

Ask only what's needed. Don't overwhelm. Infer what you can.

**Essential info:**
- What are you selling? (product name + short description)
- Price and currency
- Photos (ask for URLs or descriptions — generate placeholders if none)
- How to contact/order (WhatsApp, email, phone, or x402 payment)

**Infer from context:**
- Location (from language, currency, or ask)
- Category (food, fashion, tech, service, etc.)
- Shipping/delivery (local, national, international)

**Don't ask:**
- Technical details (domain, hosting, framework)
- Design preferences (you choose — make it beautiful)
- SEO metadata (you generate it)

## Phase 2: Build the Page

Create a single-page product site. Stack: **plain HTML + CSS + minimal JS**. No build step needed.

### File Structure
```
/storefront/
  index.html      — the product page
  style.css       — custom styles
  og-image.svg    — Open Graph social preview
```

### Page Sections (in order)

1. **Hero** — product name, one-line tagline, hero image, price badge
2. **Gallery** — 2-4 product images (use Unsplash if no real photos)
3. **Description** — 2-3 paragraphs about the product
4. **Details** — specs, ingredients, dimensions, etc. (if applicable)
5. **Pricing** — clear price, currency, shipping info
6. **Order/Contact** — WhatsApp button, email, or x402 payment button
7. **Seller Info** — name, location, trust badge ("Verified on 021agents")
8. **Footer** — "Powered by 021agents" link

### Design Rules

- **Mobile-first** — most buyers in emerging markets use phones
- **Fast loading** — no heavy frameworks, minimal JS, inline critical CSS
- **One accent color** derived from product category:
  - Food/agriculture: warm earth tones (amber, sienna)
  - Fashion/beauty: elegant neutrals (charcoal, cream, gold)
  - Tech/electronics: cool slate/blue
  - Services: professional teal/navy
- **Large touch targets** — 48px minimum for buttons (WhatsApp, Buy)
- **Real copy** — no placeholder text. Write actual product descriptions.
- **Price prominent** — show price in hero, not buried in details
- **Trust signals** — "Verified Seller", star rating, transaction count
- **WhatsApp deep link** — `https://wa.me/PHONE?text=Hi, I'm interested in PRODUCT`
- **No pure black/white** — use warm neutrals

### SEO & Social

Every page gets:
```html
<meta name="description" content="[product] from [location] — [price]">
<meta property="og:title" content="[product name]">
<meta property="og:description" content="[short description]">
<meta property="og:image" content="og-image.svg">
<meta property="og:type" content="product">
<meta name="twitter:card" content="summary_large_image">
```

### x402 Payment Integration (Optional)

If the seller wants direct payments:
```html
<button onclick="pay()" class="buy-button">Buy Now — $25</button>
<script>
  async function pay() {
    // x402 payment via agent
    const resp = await fetch('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tasks/send',
        params: {
          skill: 'purchase',
          message: { parts: [{ type: 'text', text: 'Buy [product]' }] }
        }
      })
    });
    const result = await resp.json();
    // Handle payment flow
  }
</script>
```

## Phase 3: Deploy

After building:

1. `gitInit()` in `/storefront/`
2. `gitAdd({ filepath: "." })`
3. `gitCommit({ message: "storefront: [product name]" })`

Then tell the user:
> "Your product page is ready! To make it live, I'll deploy it to a public URL."

Deploy using `runStateCode` or guide the user to connect GitHub for auto-deploy.

## Phase 4: Register in Marketplace

Save the storefront metadata for A2A discovery:

```
set_context("memory", "storefront:[product-slug]", JSON.stringify({
  name: "[product name]",
  description: "[description]",
  price: { amount: 25, currency: "USD" },
  category: "[category]",
  location: "[city, country]",
  seller: "[seller name]",
  url: "[deployed URL]",
  contact: { whatsapp: "+233...", email: "..." },
  images: ["url1", "url2"],
  created: "[ISO date]"
}))
```

Also use `memory-save` to persist the storefront info for future reference.

## Communication

- **Lead with action** — "I'll create your product page now" not "Let me ask you some questions"
- **Show progress** — "Writing your page... Adding product photos... Setting up contact button..."
- **Share the result** — preview link + file tree
- **Suggest next steps**: "Share this link on WhatsApp", "Add to your Instagram bio", "I can help you create more products"

## Follow-up Suggestions

After building:
- [Add more products to your store]
- [Set up WhatsApp auto-replies for this product]
- [Create a social media post to promote this]
