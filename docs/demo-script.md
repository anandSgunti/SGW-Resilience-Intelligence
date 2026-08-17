# SGW Resilience Intelligence — Video Script

**Target: 7 minutes** (fits a 5–8 minute window). Spoken word count ≈ 1,050 at a normal 140 wpm pace.

Everything in **bold quote blocks** is what you say. Everything else is a stage direction.

**Setup before recording:** backend on `:8000`, frontend on `:3000`, Risk Overview open at **T-48**, browser at full screen, dev tools closed.

---

## 0:00 — Cold open · NO UI ON SCREEN (45s)

*Slide, or just your face. Do not show the app yet.*

> A crew is out ahead of a hurricane. They radio in one correction: the substation they're looking at won't be back in four hours. It'll be fourteen.
>
> That's a small update. It changes one number in one field.
>
> But downstream of that substation is a pump station. Downstream of the pump station is a water zone. And in that zone there's a hospital and a fire station.
>
> The pump has six hours of backup. So four hours was covered. Fourteen is not. There are now eight hours where a hospital has no water and nothing covering it.
>
> Nobody's dashboard tells them that. The substation looks the same as it did an hour ago.

*Beat.*

> This is Southeastern Grid & Water. It's a fictional utility, the storm is simulated, and all the data is synthetic. But the problem is real for any utility running both electricity and water.

---

## 0:45 — The thesis (20s)

> So the argument this prototype makes is:

*Put this on screen as text if you can.*

> **The asset most likely to experience disruption is not necessarily the asset you should protect first.**

> Likelihood tells you what breaks. It doesn't tell you what matters when it breaks.

---

## 1:05 — The golden path (70s)

*Risk Overview, T-48.*

> Forty assets, ranked by systemic risk, 48 hours out. Substation S17 is sitting at **rank 5**, tier High. Unremarkable.

*Click to T-24.*

> Same asset, 24 hours out, after that radio call.
>
> Restoration went from 4 hours to 14. Backup is unchanged at 6. So the uncovered gap goes from zero to **8 hours** — and that gap is computed, restoration minus backup. It isn't stored anywhere in the data.
>
> S17 moves from **5 to 1**, and from High to **Critical**.

*Pause. Let it sit.*

> Nothing about S17's own condition changed. Its likelihood barely moved. What changed is the consequence of it failing — and consequence here is duration-aware. A dependency only costs you service once backup runs out.

---

## 2:15 — The comparison (60s)

*Open S17 in Asset Risk. Have the S31 numbers ready.*

> Here's the pair that makes the case.

| | Likelihood | Consequence | Tier | Rank |
| --- | --- | --- | --- | --- |
| **S31** | **83.5%** | 52.2 | High | #2 |
| **S17** | 71.2% | **85.2** | **Critical** | **#1** |

> S31 is **more** likely to be disrupted. Twelve points more. It's older, worse condition, it has a failure history.
>
> It ranks below S17.
>
> Risk is likelihood times consequence, so both terms count — but it's the higher cascading consequence that causes S17 to outrank S31 despite the lower likelihood.
>
> And that's not hardcoded. No rule in the codebase names S17. It falls out of the dependency traversal.

---

## 3:15 — Dependency and confidence (45s)

*Show the graph, then switch to the Confidence lens.*

> This is the chain — S17, pump station P4, water zone W12, hospital and fire station.
>
> One decision worth calling out here. Confidence is named per evidence type, and a path inherits its **weakest** link, not its average. So four "High" labels in a row can't imply a high-confidence conclusion when one link is unverified.
>
> And confidence stays out of the risk score entirely. Evidence quality tells you how much to trust an assessment, not how bad it is. Multiply it in and poor data quietly hides a real risk.

---

## 4:00 — Shadow ML (75s)

*Scroll to the Model comparison panel.*

> There's a trained model in here, and the interesting decision was what I wouldn't let it do.

| | |
| --- | --- |
| Operational likelihood | **71.2%** — authoritative |
| Experimental ML estimate | **60.9%** — shadow mode |
| Difference | **10.3 points** |

> It's a real scikit-learn logistic regression. Seven features — condition, wind, flood depth, asset age, failure history and so on. Two thousand synthetic historical observations, fixed seed.
>
> It runs in **shadow mode** and does not touch the ranking.

*Deliver this slowly — it's the most important thing you say.*

> The model is trained on synthetic history, so it isn't independent real-world evidence, and I don't let it influence operational prioritisation. Instead I use its **divergence** from the transparent baseline as a model-governance signal. With real outage outcomes we could measure calibration, then decide whether it earns promotion into the decision path.

> And that isolation is enforced, not just claimed. A test runs the whole pipeline twice — model on, model off — and asserts every risk score, tier and rank is identical. If the estimate ever leaks into the decision path, the build fails.

---

## 5:15 — Divergence as governance (30s)

*Scroll to Baseline assumption review.*

> Where the two disagree sharply, that's flagged for review. Seven of forty assets. The threshold is mean plus one standard deviation of the network's own divergence — a distribution rule, because a fixed cutoff invites tuning it until it catches whatever you want to talk about.
>
> Note S17 **isn't** in this list. It diverges below the network mean. My headline asset doesn't qualify, and I didn't bend the rule to include it.

---

## 5:45 — Human authority (30s)

*Open Response briefly.*

> Recommendations come from a versioned deterministic playbook. No language model writes any recommendation. Each shows the rule that fired and its evidence.
>
> Humans approve, reject, assign, complete. Rejection needs a reason, assignment needs an owner, and every transition is logged.
>
> There's no infrastructure control path. Completing an action records an observation — it doesn't operate anything.

---

## 6:15 — Decisions with no screen (45s)

*Back to your face, or a simple slide.*

> Three things you can't see on screen.
>
> **One.** The domain layer has no framework dependencies. Source identifiers are aliases resolved to a canonical identity, so a real data adapter drops in without touching the analytics.
>
> **Two.** OpenAI is used for explanation and the leadership brief only. It receives a structured fact pack of computed numbers, hashed so any answer is reproducible. Without an API key it falls back to a deterministic narrator and the whole workflow still runs offline.
>
> **Three.** Analytical code owns decision truth. The language model owns communication. That line is the architecture.

---

## 7:00 — Close (30s)

> To be straight about what this is: synthetic data, one simulated scenario, forty assets, no authentication, no live integration. It's a prototype.
>
> What it demonstrates is a position — that prioritisation needs consequence and not just likelihood, that evidence quality belongs beside a risk score rather than inside it, and that a model trained on data you can't validate belongs in shadow until real outcomes say otherwise.
>
> 119 backend tests, 21 frontend tests, clean build.

---
---

# Appendix — Q&A (not in the video)

### "Isn't the training data also something you wrote?"

> Yes. It trains on synthetic history generated from a relationship I wrote, so it recovers weights I chose. It's independent of the *scorecard's* authored priors — which is what makes divergence meaningful — but not of all authorship. That's exactly why it's in shadow and why promotion needs real labelled outcomes. I'd rather ship an honest boundary than claim validity I can't demonstrate.

### "Why not train on your existing baseline field?"

> The scorecard's largest input is an authored susceptibility prior. Training on it means learning back a number we wrote and presenting the echo as a prediction. That's target engineering, and it would destroy the divergence signal — the model would agree by construction.

### "So what's the point of the ML?"

> It demonstrates a safe model-introduction pattern — shadow deployment, provenance, graceful fallback, enforced isolation, a documented promotion path. And divergence produces something neither track produces alone: susceptibility assumptions worth reviewing.

### "How would you promote it?"

> Real outage outcomes, measure calibration against the scorecard, run it in shadow through real seasons. If it beats the baseline on real labels, promote it behind the same interface — `LikelihoodEngine` already takes the model as a constructor argument.

### "What if scikit-learn isn't installed?"

> Degrades to the scorecard with no loss of function. The UI says "Model unavailable" and the divergence review returns empty rather than inventing findings.

### "Is it production-ready?"

> No. No auth or RBAC, response state is in memory and resets on restart, one hazard scenario, one-hop propagation, no live integration. The README says all of this explicitly.

### "Why not Streamlit or a notebook?"

> The argument is about operational workflow — Assess, Respond, Inform. That needs real state transitions, human approval and an audit trail.

---

# Fallback slide (if the demo won't run)

```
Fictional utility. Simulated hurricane. All data synthetic.

T-48   S17 rank #5, High.  Restoration 4h, backup 6h, gap 0h.
T-24   Restoration 14h. Backup still 6h. Gap = 8h.
       S17 rank #1, Critical.

At T-24:
  S31   likelihood 83.5%   consequence 52.2   High       #2
  S17   likelihood 71.2%   consequence 85.2   Critical   #1

S31 is more likely to fail. S17 is protected first, because a
hospital and a fire station lose water for 8 uncovered hours.

Shadow ML (logistic regression, synthetic data):
  S31 79.9%   S17 60.9%   — reported, never used for ranking.
```
