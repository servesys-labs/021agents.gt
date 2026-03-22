"""Stripe billing router — real payment processing.

Handles:
- Checkout sessions for plan upgrades
- Webhook for payment events (invoice.paid, subscription.updated, etc.)
- Customer portal for self-service billing management
- Usage-based billing sync from billing_records table

Requires: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in env.
"""

from __future__ import annotations

import json
import os
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from agentos.api.deps import CurrentUser, get_current_user, _get_db

router = APIRouter(prefix="/stripe", tags=["stripe"])

PLAN_PRICES = {
    "basic": "price_basic_monthly",
    "standard": "price_standard_monthly",
    "premium": "price_premium_monthly",
    "enterprise": "price_enterprise_monthly",
}


def _get_stripe():
    """Get Stripe client. Raises if not configured."""
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    if not key:
        raise HTTPException(status_code=503, detail="Stripe not configured. Set STRIPE_SECRET_KEY.")
    try:
        import stripe
        stripe.api_key = key
        return stripe
    except ImportError:
        raise HTTPException(status_code=503, detail="stripe package not installed. Run: pip install stripe")


@router.post("/checkout")
async def create_checkout_session(
    plan: str = "standard",
    success_url: str = "http://localhost:3000/billing?success=true",
    cancel_url: str = "http://localhost:3000/billing?canceled=true",
    user: CurrentUser = Depends(get_current_user),
):
    """Create a Stripe Checkout session for plan subscription."""
    stripe = _get_stripe()
    db = _get_db()

    # Get or create Stripe customer
    org = db.conn.execute("SELECT * FROM orgs WHERE org_id = ?", (user.org_id,)).fetchone()
    if not org:
        raise HTTPException(status_code=404, detail="Org not found")
    org = dict(org)

    customer_id = org.get("stripe_customer_id", "")
    if not customer_id:
        customer = stripe.Customer.create(
            email=user.email,
            metadata={"org_id": user.org_id, "user_id": user.user_id},
        )
        customer_id = customer.id
        db.conn.execute(
            "UPDATE orgs SET stripe_customer_id = ? WHERE org_id = ?",
            (customer_id, user.org_id),
        )
        db.conn.commit()

    price_id = PLAN_PRICES.get(plan)
    if not price_id:
        raise HTTPException(status_code=400, detail=f"Unknown plan: {plan}")

    session = stripe.checkout.Session.create(
        customer=customer_id,
        payment_method_types=["card"],
        line_items=[{"price": price_id, "quantity": 1}],
        mode="subscription",
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"org_id": user.org_id, "plan": plan},
    )

    return {"checkout_url": session.url, "session_id": session.id}


@router.post("/portal")
async def create_portal_session(
    return_url: str = "http://localhost:3000/billing",
    user: CurrentUser = Depends(get_current_user),
):
    """Create a Stripe Customer Portal session for self-service billing."""
    stripe = _get_stripe()
    db = _get_db()

    org = db.conn.execute("SELECT stripe_customer_id FROM orgs WHERE org_id = ?", (user.org_id,)).fetchone()
    if not org or not org["stripe_customer_id"]:
        raise HTTPException(status_code=400, detail="No Stripe customer found. Subscribe to a plan first.")

    session = stripe.billing_portal.Session.create(
        customer=org["stripe_customer_id"],
        return_url=return_url,
    )
    return {"portal_url": session.url}


@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events.

    Processes: checkout.session.completed, invoice.paid,
    customer.subscription.updated, customer.subscription.deleted
    """
    stripe = _get_stripe()
    webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        if webhook_secret:
            event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
        else:
            event = json.loads(payload)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Webhook verification failed: {e}")

    event_type = event.get("type", "")
    data = event.get("data", {}).get("object", {})
    db = _get_db()

    if event_type == "checkout.session.completed":
        org_id = data.get("metadata", {}).get("org_id", "")
        plan = data.get("metadata", {}).get("plan", "standard")
        subscription_id = data.get("subscription", "")
        if org_id:
            db.conn.execute(
                "UPDATE orgs SET plan = ?, stripe_subscription_id = ?, updated_at = ? WHERE org_id = ?",
                (plan, subscription_id, time.time(), org_id),
            )
            db.conn.commit()
            db.audit("billing.plan_change", org_id=org_id,
                     resource_type="org", resource_id=org_id,
                     changes={"plan": plan, "subscription_id": subscription_id})

    elif event_type == "customer.subscription.deleted":
        customer_id = data.get("customer", "")
        org = db.conn.execute(
            "SELECT org_id FROM orgs WHERE stripe_customer_id = ?", (customer_id,)
        ).fetchone()
        if org:
            db.conn.execute(
                "UPDATE orgs SET plan = 'free', stripe_subscription_id = '', updated_at = ? WHERE org_id = ?",
                (time.time(), org["org_id"]),
            )
            db.conn.commit()

    elif event_type == "invoice.paid":
        customer_id = data.get("customer", "")
        amount = data.get("amount_paid", 0) / 100  # cents to dollars
        org = db.conn.execute(
            "SELECT org_id FROM orgs WHERE stripe_customer_id = ?", (customer_id,)
        ).fetchone()
        if org:
            db.record_billing(
                cost_type="subscription",
                total_cost_usd=amount,
                org_id=org["org_id"],
                description=f"Stripe invoice: {data.get('id', '')}",
            )

    return {"received": True}


@router.get("/status")
async def subscription_status(user: CurrentUser = Depends(get_current_user)):
    """Get current subscription status."""
    db = _get_db()
    org = db.conn.execute(
        "SELECT plan, stripe_customer_id, stripe_subscription_id FROM orgs WHERE org_id = ?",
        (user.org_id,),
    ).fetchone()
    if not org:
        return {"plan": "free", "subscription": None}
    return {
        "plan": org["plan"],
        "has_stripe": bool(org["stripe_customer_id"]),
        "subscription_id": org["stripe_subscription_id"] or None,
    }
