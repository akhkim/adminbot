// The Canadian AI proposal's track record on model training and model features.
//
// Same shape as sections.ts, different document. The Canadian proposal's own headings have not
// reached AdminBot yet, so these six blocks are organised by theme -- how the lab changes what a
// model learns and how it is trained -- and each is meant to move under the matching heading once
// the real outline arrives. Until then `number` is "Theme 1".."Theme 6" rather than a heading
// number the document does not have, and the umbrella block has none.
//
// Bullets lead with the claim and name the work that backs it, rather than listing papers by
// venue; author lists and full citations live in docs/grant-report-canadian-ai-track-record.md.
// Status words stay in the text ("under review", "target", "in preparation") so a bullet that is
// not citable as a venue cannot reach a funder looking like an acceptance. Papers are assigned to
// these ids in papers.ts, the same way the EuroSafe ones are.

import type { GrantSection } from "./sections.ts";

export const CANADIAN_SECTIONS: readonly GrantSection[] = [
  {
    id: "ca",
    number: "",
    title: "Model training and model features",
    depth: 2,
    summary:
      "How training shapes what a language model knows, how it reasons and how safely it " +
      "behaves — and training methods that change those outcomes on purpose.",
    trackRecord: {
      lede: "The Jinesis Lab (University of Toronto and Vector Institute) measures what a training step does to a model's internal representations, traces that behaviour back to the data and objective that produced it, and turns what it finds into training methods that make models more robust, more transferable and cheaper to run.",
      bullets: [
        {
          label: "Eight peer-reviewed results on this line since 2025",
          detail:
            "Representation-level safety training (EMNLP 2025, ICML 2026, Findings of EMNLP 2026), a benchmark for safety under fine-tuning (KDD 2026), an embedding-level prompt-injection defense (COLM 2026), and analyses of what fine-tuning and alignment tuning change (IASEAI 2026, Findings of ACL 2025, Findings of EMNLP 2026).",
        },
        {
          label: "Senior supervision across the line",
          detail:
            "Supervised by Zhijing Jin, with Bernhard Schölkopf (MPI-IS) as senior co-author on the training, robustness and interpretability work.",
        },
      ],
    },
  },
  {
    id: "ca.1",
    number: "Theme 1",
    title: "Training methods that make models safer and harder to break",
    depth: 3,
    parent: "ca",
    summary: "Safety built into representations during training, and tested against fine-tuning.",
    trackRecord: {
      lede: "Shaping a model's internal representations during training is a more durable safety intervention than filtering its outputs — five peer-reviewed papers show it, and the lab built the benchmark that tests whether that safety survives later fine-tuning.",
      bullets: [
        {
          label: "Safety trained into representations, not bolted onto outputs",
          detail:
            "Contrastive representation learning (EMNLP 2025) trains safety into the model's internal representations; predictive representation alignment (Findings of EMNLP 2026) improves how that safety generalizes.",
          links: [{ text: "EMNLP 2025", href: "https://aclanthology.org/2025.emnlp-main.1430/" }],
        },
        {
          label: "Models that fail safely when an attack gets through",
          detail:
            "Honeypot training (ICML 2026) shapes the failure modes a model falls into under adversarial attack.",
        },
        {
          label: "Defenses for agents that call tools",
          detail:
            "ODILE (COLM 2026) blocks prompt injection by disrupting injected tool-call embeddings; Weight-Level Defenses (NeurIPS 2026, under review) moves the defense into the weights.",
        },
        {
          label: "A benchmark for whether safety survives fine-tuning",
          detail:
            "TamperBench (KDD 2026) stress-tests a model's safety under fine-tuning and tampering.",
          links: [{ text: "arXiv", href: "https://arxiv.org/abs/2602.06911" }],
        },
        {
          label: "Next in the pipeline",
          detail:
            "RepPO, diffusion concept erasure and MoE unlearning (ICLR 2026, under review); adversarial robustness with RLVR and a triplet loss (in preparation).",
        },
      ],
    },
  },
  {
    id: "ca.2",
    number: "Theme 2",
    title: "Post-training for reasoning, transfer and knowledge injection",
    depth: 3,
    parent: "ca",
    summary: "Making a capability learned once carry over to other domains, languages and models.",
    trackRecord: {
      lede: "A model trained once should be usable more widely: the lab builds post-training methods that carry a capability across reasoning domains, across languages, and from a large teacher into a small student. This line is mostly in the current cycle.",
      bullets: [
        {
          label: "Reasoning that transfers across domains",
          detail:
            "An automated curriculum for multi-domain RL that orders training by how well each domain transfers (NeurIPS 2026, under review).",
          links: [{ text: "arXiv", href: "https://arxiv.org/abs/2606.25178" }],
        },
        {
          label: "New knowledge without retraining from scratch",
          detail:
            "MixSD injects knowledge through mixed contextual self-distillation (target: NeurIPS; check); a hybrid distillation framework makes complex reasoning learnable by small models (in preparation).",
        },
        {
          label: "Reasoning across languages, at lower cost",
          detail:
            "Unsupervised elicitation of cross-lingual transfer in math reasoning (target: ARR) and length-penalized RL that shortens reasoning chains.",
        },
        {
          label: "Agents trained to cooperate",
          detail:
            "MoralGym (ICLR 2026, under review), RL for game theory (target: EMNLP) and evolutionary pressures for cooperative language models.",
        },
      ],
    },
  },
  {
    id: "ca.3",
    number: "Theme 3",
    title: "Understanding what training does to a model",
    depth: 3,
    parent: "ca",
    summary: "Measuring what fine-tuning and alignment tuning change inside a model.",
    trackRecord: {
      lede: "Training choices should be made on evidence: the lab measures what a training step actually changes inside a model — which safeguards fine-tuning erodes, how alignment tuning reshapes the representations behind sycophancy, and how facts are forgotten.",
      bullets: [
        {
          label: "Which fine-tuning choices erode safeguards",
          detail:
            "Accidental Vulnerability (IASEAI 2026) identifies the factors in fine-tuning that shift a model's safeguards.",
          links: [{ text: "arXiv", href: "https://arxiv.org/abs/2505.16789" }],
        },
        {
          label: "Reasoning and memorization share one switch",
          detail:
            "The interplay between reasoning and memorization is mediated by a single direction in the model (Findings of ACL 2025).",
          links: [{ text: "arXiv", href: "https://arxiv.org/abs/2503.23084" }],
        },
        {
          label: "What alignment tuning does to representations",
          detail:
            "How alignment tuning shapes the representations behind sycophancy and cue-induced biases, and how representations stay fluid in reasoning models (both Findings of EMNLP 2026).",
          links: [{ text: "Fluid Representations", href: "https://arxiv.org/abs/2602.04843" }],
        },
        {
          label: "Next in the pipeline",
          detail:
            "How models forget facts (ICLR 2026, under review), the training dynamics of causal reasoning with MPI-IS (in preparation), learning exceptions without overwriting the rule, and how user feedback shapes assistant personas (target: ICLR).",
        },
      ],
    },
  },
  {
    id: "ca.4",
    number: "Theme 4",
    title: "Tracing model behaviour back to the training data",
    depth: 3,
    parent: "ca",
    summary: "Attribution for pre-training, SFT and RLVR, and contamination detection.",
    trackRecord: {
      lede: "When a model behaves badly, the lab can point to the data and the training stage that caused it — with attribution methods for pre-training, supervised fine-tuning and RL with verifiable rewards.",
      bullets: [
        {
          label: "Contamination read from the model's own decay",
          detail:
            "Test of Time (ACL 2026) treats post-cutoff performance decay as a temporal signal of benchmark contamination.",
          links: [{ text: "arXiv", href: "https://arxiv.org/abs/2509.00072" }],
        },
        {
          label: "Attribution that scales",
          detail:
            "STRIDE recovers which training data drove a behaviour from subset perturbations (NeurIPS 2026, under review).",
          links: [{ text: "arXiv", href: "https://arxiv.org/abs/2606.05165" }],
        },
        {
          label: "Attribution at every training stage",
          detail:
            "Methods for SFT and an influence-function framework for RLVR (ICLR 2026, under review), applied to where political framings in model output come from (ARR 2026, under review).",
        },
      ],
    },
  },
  {
    id: "ca.5",
    number: "Theme 5",
    title: "Efficient and privacy-preserving models",
    depth: 3,
    parent: "ca",
    summary: "Cutting what a model costs to run and protecting the data it was trained on.",
    trackRecord: {
      lede: "Models are cheaper to run and safer to train on private data when cost and privacy are designed into training. All of this block is current-cycle work.",
      bullets: [
        {
          label: "Private training for mixture-of-experts",
          detail: "RAPTOR, role-aware private training for MoE models (target: AAAI; check).",
        },
        {
          label: "Cheaper grounding through pruning",
          detail:
            "PruneGround, language-guided spatial pruning for efficient 3D visual grounding (target: EMNLP; check).",
        },
        {
          label: "When a memory mechanism works",
          detail:
            "A framework for what model memory is and when a memory mechanism performs well, with Nicolas Papernot (target: NeurIPS).",
        },
      ],
    },
  },
  {
    id: "ca.6",
    number: "Theme 6",
    title: "Open tools and benchmarks others can use",
    depth: 3,
    parent: "ca",
    summary: "The released infrastructure behind the results above.",
    trackRecord: {
      lede: "The lab releases the infrastructure behind its results, so other groups can rerun and extend them.",
      bullets: [
        {
          label: "An open library for cross-layer transcoders",
          detail:
            "CLT-Forge (EMNLP 2026 Demo) trains cross-layer transcoders and builds attribution graphs at scale; the lab's multilingual tracing paper (EMNLP 2026) is built on the same method.",
          links: [
            { text: "CLT-Forge", href: "https://arxiv.org/abs/2603.21014" },
            { text: "multilingual", href: "https://arxiv.org/abs/2511.10840" },
          ],
        },
        {
          label: "A public safety benchmark",
          detail: "TamperBench (KDD 2026), from Theme 1, released for outside use.",
          links: [{ text: "arXiv", href: "https://arxiv.org/abs/2602.06911" }],
        },
        {
          label: "Lab operations, in production",
          detail:
            "AdminBot, a multi-agent lab-operations system in daily use (ARR 2026, under review). [needs number: stars, downloads or outside users for CLT-Forge and TamperBench]",
        },
      ],
    },
  },
];
