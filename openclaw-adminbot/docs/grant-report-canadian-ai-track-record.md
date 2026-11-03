# Canadian AI proposal: track record on model training and model features

This is the Canadian-funder version of [`grant-report-track-record.md`](grant-report-track-record.md).
That doc follows the section headings of the EuroSafeAI proposal. We do not have the Canadian
proposal's headings yet, so this one is organised around one theme instead: **how the lab improves
what models learn and how they are trained**. Once the real headings arrive, each block below can be
moved under the matching heading.

Sources are the same two as the EuroSafe doc. Clean citations come from the **Formatted Papers** tab
of the mentee survey (via the EuroSafe doc). Work that is not in the survey yet comes from the
AdminBot Grant Report snapshot (`ui/src/ui/adminbot/grant-report/papers.ts`, compiled 2026-08-27
from the *papers* tab of the Jinesis contact sheet).

Each block opens with a single claim and backs it with named, checkable work. Papers are not just
listed by venue.

## Before you paste

The status markers mean the same as in the EuroSafe doc. Lines with no marker are citable as written.

| Marker | Meaning |
| --- | --- |
| `[under review]` | Submitted, not accepted. |
| `[target: X]` | The contact sheet records X only as a *target* venue with a confidence estimate. Nothing has been submitted that we can confirm. Do not present it as a venue. |
| `[in preparation]` | No venue recorded. |
| `[no public URL]` | Nothing citable in either sheet. No link was invented, and private Overleaf projects were not used. |
| `[accepted; no public URL]` | Accepted, but no public link yet. |
| `[check]` | The two sources disagree, or the row is too thin to cite without asking the author. |

---

## Lab statement (opening paragraph)

> Paste this before the section blocks, or use it as the "team / track record" summary.

```
The Jinesis Lab (University of Toronto and Vector Institute) studies how training shapes what a
language model knows, how it reasons, and how safely it behaves -- and builds training methods that
change those outcomes on purpose. Our work runs along one line: we measure what a training step does
to a model's internal representations, trace that behaviour back to the data and the objective that
produced it, and then turn what we find into training methods that make models more robust, more
transferable and cheaper to run. Peer-reviewed results along this line include representation-level
safety training (EMNLP 2025, ICML 2026, Findings of EMNLP 2026), a stress-testing benchmark for
safety under fine-tuning (KDD 2026), a defense against prompt injection at the embedding level
(COLM 2026), and analyses of how fine-tuning and alignment tuning shift model behaviour (IASEAI 2026,
Findings of ACL 2025, Findings of EMNLP 2026). We release the tools behind this work, including
CLT-Forge, an open library for cross-layer transcoders (EMNLP 2026 Demo). The lab is supervised by
Zhijing Jin, with Bernhard Schölkopf (MPI-IS) as senior co-author across the training, robustness and
interpretability lines.
```

## 1. Training methods that make models safer and harder to break

```
Our track record on this topic:
We have shown, across five peer-reviewed papers, that shaping a model's internal representations
during training is a more durable safety intervention than filtering its outputs, and we have built
the benchmark that tests whether that safety survives later fine-tuning.
(EMNLP 2025) Improving Large Language Model Safety with Contrastive Representation Learning. Samuel Simko et al. https://aclanthology.org/2025.emnlp-main.1430/
(ICML 2026) Shaping Failure Modes in Language Models under Adversarial Attacks (honeypot training). Samuel Simko et al. https://drive.google.com/file/d/1SS0R_ah7mOqSgZHkOViqAFA7YbLOVQLj/
(Findings of EMNLP 2026) Predictive Representation Alignment Improves Generalization in LLM Safety. Samuel Simko et al. https://drive.google.com/file/d/1EoczN6W2wdsOAljhTreOqI3ZOsKGH0v8/
(COLM 2026) ODILE: Orthogonal Disruption of Injected Tool-Call Embeddings for Agentic Prompt Injection Defense. Ozdincer et al. https://drive.google.com/file/d/1BC_r4ca7CPmFR6d2QzcXe0esuYp8paKH/
(KDD 2026) TamperBench: Systematically Stress-Testing LLM Safety Under Fine-Tuning and Tampering. Hossain et al. https://arxiv.org/abs/2602.06911
(NeurIPS 2026) Weight-Level Defenses Improve LLM Agent Adversarial Robustness. Memo Ozdincer et al. [under review; no arXiv planned]
(ICLR 2026) RepPO: Representation Preference Optimization. Damiano et al. [under review; no public URL]
(ICLR 2026) Diffusion concept erasure defense with contrastive representation learning. Samuel, Rishit. [under review; no public URL]
(ICLR 2026) MoE LLM Unlearning. Khai Le-Duc. [under review; no public URL]
(2026) Adversarial Robustness with RLVR + Triplet Loss. Suvajit, Samuel, Jacob. [in preparation; no URL]
```

## 2. Post-training for reasoning, transfer and knowledge injection

> Thinner on accepted work than section 1: most of it is in the current cycle. The lede is written
> so it does not overclaim. Drop any `[target: …]` line you would rather not show a funder.

```
Our track record on this topic:
We develop post-training methods that make a capability learned in one setting carry over to
others -- across reasoning domains, across languages, and from a large teacher into a small
student -- so that a model trained once can be used more widely.
(NeurIPS 2026) Transferability for General Reasoning: An Automated Curriculum for Multi-Domain LLM RL. Yongjin Yang et al. https://arxiv.org/abs/2606.25178 [under review]
(NeurIPS 2026) MixSD: Mixed Contextual Self-Distillation for Knowledge Injection. Jiarui et al., with Mona. [target: NeurIPS; no public URL; check]
(2026) Unsupervised Elicitation of Cross-Lingual Transfer in Math Reasoning. Gopal, Rishitej, Terry. [target: ARR; no public URL]
(2026) Making Complex Reasoning Student-Friendly: A Hybrid Distillation Framework for Small Language Models. [in preparation; authors not recorded; check]
(2026) Length-Penalized RL for Math Reasoning. Khai Le-Duc. [target venue not recorded; no URL]
(ICLR 2026) MoralGym: Finetuning Cooperative LLM Agents. Yves et al. [under review; no public URL]
(2026) RL for Game Theory. Colomban, Arth, Pepijn, Zhijing Jin. [target: EMNLP; no URL]
(2026) Evolutionary Pressures for Cooperative Language Models. Mariana. [target: ICLR or ARR; no URL]
```

## 3. Understanding what training does to a model

```
Our track record on this topic:
We measure what a training step actually changes inside a model -- which safeguards fine-tuning
erodes, how alignment tuning reshapes the representations behind sycophancy, and how facts are
forgotten -- so that training choices can be made on evidence rather than by trial and error.
(IASEAI 2026) Accidental Vulnerability: Factors in Fine-Tuning that Shift Model Safeguards. Jingchen Zhang et al. https://arxiv.org/abs/2505.16789
(Findings of ACL 2025) The Reasoning-Memorization Interplay in Language Models Is Mediated by a Single Direction. Yihuai Hong et al. https://arxiv.org/abs/2503.23084
(Findings of EMNLP 2026) How Does Alignment Tuning Shape Representations of Sycophancy and Related Cue-Induced Biases in LLMs?. Prakhar Gupta et al. [no public URL]
(Findings of EMNLP 2026) Fluid Representations in Reasoning Models. Dmitrii Kharlapenko et al., with Arthur Conmy and Mrinmaya Sachan. https://arxiv.org/abs/2602.04843
(ICLR 2026) How Do Language Models Forget Facts? Decomposing Suppression and Erosion. Vedant Palit et al. [under review; no public URL]
(ICML 2026 / ARR) Training Dynamics of Causal Reasoning in LLMs. Rahul et al., with MPI-IS. [in preparation; no URL]
(2026) Learning Exceptions Without Overwriting the Rule: Coherence, Reuse, and Containment from Modular MLPs to Fine-Tuned LLMs. Vincent, Vedant. [in preparation; no URL]
(2026) User-Feedback Contingency Shapes Assistant Personas. Arth et al., with the Nick Haber lab (Stanford). [target: ICLR; no public URL]
```

## 4. Tracing model behaviour back to the training data

```
Our track record on this topic:
When a model behaves badly, we can point to the training data and the training stage that caused
it: we have built attribution methods for pre-training, supervised fine-tuning and RL with
verifiable rewards, and a way to detect benchmark contamination from the model's own performance
over time.
(ACL 2026) Test of Time: Rethinking Post-Cutoff Performance Decay as a Temporal Signal of Contamination. Jingchen Zhang et al. https://arxiv.org/abs/2509.00072
(NeurIPS 2026) STRIDE: Training Data Attribution via Sparse Recovery from Subset Perturbations. Rishit et al. https://arxiv.org/abs/2606.05165 [under review]
(ICLR 2026) Training Data Attribution for SFT. Arth et al., with the Nick Haber lab (Stanford). [under review; no public URL]
(ICLR 2026) Influence Functions Framework for RLVR. Han et al. [under review; no public URL]
(ARR 2026) Where Political Framings Come From: Training Data Attribution for LLM Output. Arth Singh et al. [under review; no public URL]
```

## 5. Efficient and privacy-preserving models

> The smallest block. It is here because a Canadian funder asking about model training is likely to
> care about cost and data protection. Fold it into section 2 if the proposal has no matching heading.

```
Our track record on this topic:
We design training and inference methods that cut what a model costs to run and protect the data it
was trained on, including private training for mixture-of-experts models and language-guided
pruning for 3D grounding.
(AAAI 2026) RAPTOR: Role-Aware Private Training for Mixture-of-Experts. Khai Le-Duc. [target: AAAI; no public URL; check]
(EMNLP 2026) PruneGround: Language-Guided Spatial Pruning for Efficient 3D Visual Grounding. Duc Cao Dinh, Khai Le-Duc et al. [target: EMNLP; no public URL; check]
(NeurIPS 2026) What Is Memory, How Ought We Store It, and When Will My Memory Mechanism Perform Well?. Andrei et al., with Nicolas Papernot. [target: NeurIPS; no public URL]
```

## 6. Open tools and benchmarks others can use

```
Our track record on this topic:
We release the infrastructure behind our results so other groups can rerun and extend them.
(EMNLP 2026 Demo) CLT-Forge: A Scalable Library for Cross-Layer Transcoders and Attribution Graphs. Florent Draye et al. https://arxiv.org/abs/2603.21014
(KDD 2026) TamperBench: Systematically Stress-Testing LLM Safety Under Fine-Tuning and Tampering. Hossain et al. https://arxiv.org/abs/2602.06911
(EMNLP 2026) Tracing Multilingual Representations in LLMs with Cross-Layer Transcoders. Abir Harrasse, Florent Draye (equal contribution) et al. https://arxiv.org/abs/2511.10840
(ARR 2026) AdminBot: a multi-agent lab-operations system in daily production use. Andrew et al. [under review; no public URL]
GitHub stars as of November 2026: [CLT-Forge](https://github.com/LLM-Interp/CLT-Forge) 111, [TamperBench](https://github.com/criticalml-uw/TamperBench) 34. Refresh these before sending.
```

---

## Notes

- **38 paper lines across six blocks. 12 are citable as written** (11 distinct papers; TamperBench
  is listed twice on purpose). Sections 1, 3 and 6 can stand on their citable lines alone. Sections
  2 and 5 have no citable line yet: everything in them is current-cycle work.
- **The `[target: X]` lines come from the contact sheet's venue column**, which records a planned
  venue and a confidence estimate ("NeurIPS 100%", "AAAI 100%"), not a submission. MixSD, RAPTOR and
  PruneGround are marked `[check]` because a 100% target could mean they have since been submitted
  or accepted. Ask Jiarui and Khai before sending.
- **Only one Canadian fact is used:** the lab's affiliation as written in AdminBot
  (`docs/tools/adminbot.md`): "Jinesis Lab, University of Toronto & Vector Institute". No Canadian
  funding history, partners or compute allocations are claimed, because none are recorded in either
  source. Add them by hand if they exist.
- **Left out on purpose:** papers whose contribution is evaluation or multi-agent behaviour with no
  training component (GT-HarmBench, CoopEval, the democracy line). They are in the EuroSafe doc if
  the Canadian proposal turns out to want them.
- **Names.** As in the EuroSafe doc, first-name-only author strings come straight from the contact
  sheet. Do a pass on them before a reviewer sees this.
