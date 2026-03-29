# Comprehensive Video Walkthrough Script

*This script continues your exact tone from the intro all the way through the codebase walkthrough, covering every major technical decision in your unique voice.*

---

## Part 1: Introduction and Live Demo (0:00 – 4:30)

**[Screen: `/login` at `http://localhost:3000`]**

"Hey, I am Bhargav, an 18-year-old student from Bangalore, India. I have learned all of full-stack through my curiosity and the projects and issues which I faced throughout my development career. I have worked with a small-scale Medtech startup before as an intern, and before that, I had co-founded a music-based dating app with one of my college seniors where I handled the technical side of the app building and all of that." 

"I found Amboras online—congratulations on your YC selection, by the way!—and I messaged the founder, Amin. He gave me a small task to take home and build. It is to build a full-stack application for an analytics experience so that it is close to production, has multi-tenant support, and steady updates without the UI falling apart. You want the store owners to have all their analytics in real-time, so that is what I have built right now as a small project."

**[Action: Hover over the login fields]**

"There are three different stores right now. This is just to simulate what happens in real life—how the store owners can log into their stores using their username, password, and JWT authentication."

**[Action: Click Store 1 to log in]**

"In our project right now, I have removed that manual entry a bit so that it is easier for my sake to show you guys how the store backend works. Let's just go to Store One. Auth is JWT-based. On the backend, it is set as an `httpOnly` cookie with the access token, so scripts cannot read that cookie. The API also returns the same token in the JSON body. The dashboard stores that in local storage and sends it into an API call in the bearer header."

**[Screen: Dashboard for Store 1 loads]**

"We have run a script in the background which sends in data to the frontend. It simulates the data based on the order type and all of that given in the PRD, so it gives it a real feel—like 'okay, this is happening right now.'"

"When the dashboard loads, you can see the layout: a tight, high-density grid of metrics, charts, funnel, top products, and recent activity. It is meant to feel more like an operations console than a marketing page."

**[Action: Hover over the sync line at the top]**

"Up top is the sync line. You have the last sync time, a live edge counter, and a note that we are polling on an interval. You see that in the sync counter—sync successfully, and a round trip. Now there are:"
* "Revenue today"
* "Revenue this week"
* "Revenue this month"
* "Revenue range within the selected dates"
* "The conversion rate"
* "All the necessary details required, from your brand cards and all of that."

**[Action: Point at the Live Visitors counter]**

"What I have done with the Live Visitors is that it can jitter every single time it moves, so I smoothened the display number on the client side itself. I blend the new value with the previous one and cap how far it can jump at one time. You don't want it to keep on glitching and all; it is not a nice user experience. Instead of looking like a broken counter, it feels calm, organic, getting that smooth feel without having to open a full WebSocket."

**[Action: Scroll to the Recent Activity feed]**

"Before I log out, I'll just show you this. It gives you live logs every 2.5 seconds because I've used polling over here. It gives you live logs on what is added to cart, what product is added to cart, and what purchase is made—and how much the purchase was made for. It then gives you detailed information like:"
* "Okay, this is the number of page views."
* "How many were added to the cart."
* "How many started the checkout process."
* "How many removed them from the cart."
* "And how many actually purchased it."

"It also gives you a detailed description of how many products were sold, and tells you which product is basically the most sold."

**[Action: Log out, then log in as Store 3]**

"After that, I'll quickly log out and log into Store number three. Store three is one of the stores which is lesser used. It is like: Store 1 is high users and high revenue, Store 2 in the middle, and Store 3 is that lower tier."

"I have set this through the script as well—how many sales were made, how many sales per minute were made. We are polling every 2.5 seconds to give sort of a natural feel of it being live, rather than using actual WebSockets. This is a trade-off which I have made in this demo, but I am planning on making this better for the actual production level. We can use a WebSocket so when a user actually makes a purchase, it shows in your dashboard immediately."

"It is the same app but a different `store_id` in the token. The numbers and activity reflect this exact tenant only; it does not leak into other profiles. I have put a guardrail like that, and that is one of the features which was suggested in the PRD as well. Our demo data is also tiered on purpose, as I've mentioned before."

"By the way, I just wanted to mention that when I say 'less', I mean the standards for a normal shop. I genuinely looked at your product and I feel how good the product is and, honestly, how the store operates on Amboras... I feel like it's going to be a couple hundred sign-ups or purchases per minute. Store One is like the baseline kept for all other products; that's how great I feel the product is."

---

## Part 2: Backend Walkthrough (4:30 – 8:00)

**[Screen: Open your IDE and go directly to `backend/src/auth/tenant.guard.ts`]**

"Okay, now moving on to the code. This is the Tenant Guard. This is the thing which I just mentioned we're putting a guardrail on."

"On the backend, what I've basically done is make it so you cannot pick your `store_id` from the request body to peek at another store. The tenant ID has to come from a verified identity. So this Nest TenantGuard resolves the bearer token in a fixed order. First, it looks at the Authorization header—which is what our frontend normally sends. Then it checks for an optional query token, and finally, it falls back to the `httpOnly` cookie." 

"When it gets the token, it verifies it with the server secret and specifically reads the `store_id` out of the payload. I attach that directly to the request object. So every single query we run is securely filtered on that exact ID. It's basically impossible to snoop on someone else's data, and all of that is handled cleanly at the routing layer before it even hits the database."

**[Screen: Switch to `backend/src/analytics/analytics.service.ts` and highlight `getDashboardSnapshot`]**

"Now if we look at the Analytics Service, I want to show you how I handle all the data querying. Rather than building a complicated pipeline, I just hit the Postgres database directly. The raw `analytics_events` table is the source of truth."

"But because the dashboard needs up-to-the-minute math for revenue, visitors, funnels, top products, and recent activity, executing those queries one-by-one would be super slow. So what I have done is fan out the work into a massive `Promise.all`. We run all six logical slices in parallel asynchronously. So instead of waiting for query 1, then query 2... the entire API response is only as slow as the single longest query."

**[Screen: Just scroll through the SQL or optionally mention `schema.sql`]**

"And to make sure Postgres doesn't die when answering those queries every 2.5 seconds, I implemented composite and partial indexes on the database side for `store_id`, `timestamp`, and `event_type`. So when we run aggregations, the database scans are super fast and practical for this demo scale. There’s also an optional Redis cache layer in here, but I wired the endpoint with no TTL right now so you can dynamically see fresh numbers on every poll."

---

## Part 3: Frontend Walkthrough (8:00 – 11:00)

**[Screen: Switch to `frontend/lib/api.ts`]**

"Going over to the frontend codebase, before we look at the UI, I just want to point out `api.ts`. When we make an API call from the browser, I actually point it to `/api/v1`—which is handled by Next.js rewrites. That means the browser thinks we're talking to the exact same origin, which natively passes our secure cookies and completely bypasses CORS errors. This makes the frontend fetching super predictable and clean."

**[Screen: Switch your IDE to `frontend/components/dashboard.tsx`]**

"Now, in my main `dashboard.tsx` file, we have our polling constant set to about 2.5 seconds. Like I said, this is HTTP polling. But if you just let a charting library like Recharts fetch new data every 2.5 seconds, it naturally wants to run its cool little entrance animation. It evaluates that new data and reboots." 

"If that happens on a 2.5-second loop, the UI looks like it's glitching out—it keeps animating over and over, and that is not a nice user experience. So what I’ve done is force `isAnimationActive={false}` on all the chart lines and areas. The chart just anchors solidly on the page and the data drops in seamlessly. It gives it that very calm, professional vibe."

**[Action: Highlight the `DEMO_STORE_PROFILES` object at the top of the file]**

"And finally, to build the demo data, I didn't want to just shoot out 100% random numbers because that just looks basically like noise. So I engineered these `DEMO_STORE_PROFILES`. I gave Store 1 a massive traffic base and a high purchase rate, and Store 3 a lower base." 

"When we simulate the event flow, the function uses a deterministic seed that naturally respects a conversion funnel. So 'Page Views' mathematically bleed down into 'Add-to-Carts', and those bleed down into 'Checkouts'. It keeps everything internally coherent so the charts actually look like real-world Amboras traffic."

---

## Part 4: Conclusion (11:00 – 12:00)

**[Screen: Back in the Browser showing the Store 1 dashboard]**

"So yeah, that's basically it! I’m really happy with how the multi-tenant architecture and the UI stability turned out."

"As a trade-off, hitting read-time SQL every two seconds is great for this MVP because it's always accurate. But at production scale, open tabs multiplied by that poll rate would definitely start to stress a single database. So if I had more time, I would focus on three things:"

1. **"Data:"** "I would move the data to a time-series extension like continuous aggregates, so the dashboard reads pre-aggregated 1-minute buckets instead of scanning raw events every time."
2. **"Caching:"** "I’d turn on the Redis cache with a short TTL, so if a hundred store admins poll at the exact same millisecond, the DB only does the math once."
3. **"Network:"** "And I would transition to actual WebSockets or Server-Sent Events—which I already have an endpoint stubbed out for—so we just push increment updates instead of brute-force polling."

"Thank you so much to Amin and the Amboras team for letting me build this out. I really enjoyed the challenge and all of that, and I hope this walkthrough was insightful!"
