// The proposal's technical agenda (Part 1), down to the level that needs a track record.
//
// One entry per heading of Part 1 of the EuroSafeAI 2-year proposal, each carrying a `trackRecord`
// block written in the shape Part 2.3 of that document already uses for the workshop item: a lede
// that claims the standing, then bullets that each name a specific artefact and its numbers.
//
// The deepest level is where the proposal actually argues -- Part 1.1.1's A/B/C hacking interfaces
// are the claim, and the section above them is a frame -- so they carry their own block rather than
// being summarised into the parent's.
//
// Everything here is a written claim about the lab, so it is prose kept by hand, not generated. The
// papers it cites are in `papers.ts`, and `linkage.ts` checks that every paper this file names by
// section is one that file also assigns to that section.

export type TrackRecordBullet = {
  /** The bolded lead-in: the artefact's name, and its venue when it has one. */
  label: string;
  /** The claim, with whatever numbers make it checkable. */
  detail: string;
  links?: readonly { text: string; href: string }[];
};

export type TrackRecord = {
  lede: string;
  bullets: readonly TrackRecordBullet[];
};

export type GrantSection = {
  id: string;
  /** "Part 1.1.2", "A", ... exactly as the heading reads in the document. */
  number: string;
  title: string;
  /** Heading depth in the document, so the tree renders in the reader's own numbering. */
  depth: 2 | 3 | 4;
  parent?: string;
  /** One line on what the section proposes, for readers who have not opened the document. */
  summary: string;
  trackRecord: TrackRecord;
};

export const GRANT_SECTIONS: readonly GrantSection[] = [
  {
    id: "p1.1",
    number: "Part 1.1",
    title: "When agents interact with their environment",
    depth: 2,
    summary:
      "8 technical leads and ~40 researchers on evaluation validity, misalignment, adversarial " +
      "defense, generalization and interpretability. Rough plan: 8M personnel + 2M compute.",
    trackRecord: {
      lede: "The working group already runs at close to the proposed shape: the papers below are the lab's current cycle across all five sub-agendas, submitted or under review at NeurIPS, ICLR and EMNLP 2026.",
      bullets: [
        {
          label: "Five sub-agendas, all already staffed",
          detail:
            "Evaluation hacking, misalignment, adversarial defense, science of generalization and interpretability each have at least four papers in the current cycle with a named first author and a committed venue.",
        },
        {
          label: "Senior supervision in place",
          detail:
            "Bernhard Schölkopf and Zhijing Jin are senior authors across the interpretability, adversarial-defense and generalization lines, with external senior collaborators including Rada Mihalcea, Nicolas Papernot, Vincent Conitzer, Maksym Andriushchenko and Mrinmaya Sachan.",
        },
      ],
    },
  },
  {
    id: "p1.1.1",
    number: "Part 1.1.1",
    title: "Evaluation hacking",
    depth: 3,
    parent: "p1.1",
    summary:
      "Taxonomize where eval hacking can occur, apply the taxonomy to real evaluations, then " +
      "publish a position paper with a best-practice checklist.",
    trackRecord: {
      lede: "We are already running this agenda rather than proposing to start it: a themed MARS research stream, a first empirical paper on each of the three hacking interfaces, and a position paper in draft.",
      bullets: [
        {
          label: "MARS V stream themed on evaluation hacking",
          detail:
            "A full mentored research stream (Samuel, Arth, Lily, Nirav) dedicated to the taxonomy, from which the hacking interfaces below were identified in AI R&D benchmarks including SciAgentGym and MLE-Bench.",
        },
        {
          label: "Eval Hacking in AI4Science Benchmarks (ICLR 2026 submission)",
          detail:
            "The first application of the taxonomy to a benchmark family in the wild, showing models optimizing report phrasing to move judge scores without changing the underlying scientific artefact.",
        },
        {
          label: "Position: Science is collaborative and LLM for Science should be too",
          detail:
            "The position-paper track for the checklist deliverable, targeted at NeurIPS 2026 for feedback and then a general-science venue.",
        },
      ],
    },
  },
  {
    id: "p1.1.1.A",
    number: "A",
    title: "Data-Level Hacking from Contamination",
    depth: 4,
    parent: "p1.1.1",
    summary:
      "Perturb-native evaluation: measure the delta in evaluation results under systematic " +
      "perturbation of input context, needing only black-box access.",
    trackRecord: {
      lede: "Our contamination work comes out of an established training-data-attribution line, which is what lets us make claims about indirect contamination that n-gram overlap cannot see.",
      bullets: [
        {
          label: "Training Data Attribution for SFT (ICLR 2026 submission)",
          detail:
            "With the Stanford Nick Haber lab: attributing fine-tuned behavior back to specific training examples, the measurement primitive the perturb-native paradigm needs.",
        },
        {
          label: "Influence Functions Framework for RLVR (ICLR 2026 submission)",
          detail:
            "Extends influence-function attribution to verifier-rewarded RL, where contamination of the verifier rather than of the corpus is the live risk.",
        },
        {
          label: "Causality can systematically address the monsters under the bench(marks)",
          detail:
            "The framing paper for treating benchmark validity as a causal-inference problem rather than a string-matching one.",
        },
      ],
    },
  },
  {
    id: "p1.1.1.B",
    number: "B",
    title: "Model-Level Hacking from Situational Awareness",
    depth: 4,
    parent: "p1.1.1",
    summary:
      "Interp-native detection of evaluation awareness: incorporate mechanistic interpretability " +
      "during evaluation to detect when a model knows it is being tested.",
    trackRecord: {
      lede: "We published the first systematic evaluation framework and empirical results on evaluation awareness, and it is the direct predecessor of this sub-agenda.",
      bullets: [
        {
          label: "Eval Awareness (NeurIPS 2026)",
          detail:
            "The first systematic framework and empirical results for evaluation awareness across mainstream benchmarks, with Changling, Terry Jingchen Zhang, Zhijing Jin, Sahar Abdelnabi and Maksym Andriushchenko. Grew directly out of last year's grant project on real-unreal agent harm evaluation.",
          links: [
            {
              text: "arXiv:2605.23055",
              href: "https://arxiv.org/abs/2605.23055",
            },
          ],
        },
        {
          label: "Detect Deception by Interp (llama-70B probe)",
          detail:
            "Probe-based detection of deceptive states at 70B scale (Johannes, Terry, Florent) -- the interp half of interp-native awareness detection, on an open-weight model large enough to matter.",
        },
        {
          label: "Continuous monitoring already in practice",
          detail:
            "We re-run foundational misalignment evals on each frontier release and have observed recent Claude and OpenAI models recognizing the older scenarios, which is the finding that motivates in-situ scenario synthesis.",
        },
      ],
    },
  },
  {
    id: "p1.1.1.C",
    number: "C",
    title: "System-Level Hacking from Agentic Interaction",
    depth: 4,
    parent: "p1.1.1",
    summary:
      "Reward hacking against proxy metrics, and agents persuading the judge rather than " +
      "improving the output; scalable oversight with a monitor separate from the judge.",
    trackRecord: {
      lede: "Judge hacking is a line we have already published on, with the failure mode demonstrated end to end rather than argued for.",
      bullets: [
        {
          label: "Judging the Judges (NeurIPS 2026)",
          detail:
            "Arth, Samuel, Bernhard Schölkopf and Zhijing Jin on LLM-judge reliability -- the empirical basis for separating the overseer from the grader.",
        },
        {
          label: "Eval Hacking in AI4Science Benchmarks (ICLR 2026 submission)",
          detail:
            "Demonstrates agents moving judge scores by rewording their report while the underlying scientific artefact is unchanged.",
        },
        {
          label: "Root Cause Analysis for MCP Servers",
          detail:
            "Calum and Rahul, on tracing agentic failures through real tool-calling infrastructure rather than a toy main-task / side-task harness.",
        },
      ],
    },
  },
  {
    id: "p1.1.2",
    number: "Part 1.1.2",
    title: "Misalignment",
    depth: 3,
    parent: "p1.1",
    summary:
      "Systematic, theory-grounded evals for misalignment ranked by goal-directedness, from " +
      "sycophancy to alignment faking, with multi-turn and in-situ scenario synthesis.",
    trackRecord: {
      lede: "This is our largest publishing line, and each of the three systematic benchmarks named in the proposal already exists as a NeurIPS 2026 paper rather than as a plan.",
      bullets: [
        {
          label: "AF-Arena — Alignment Faking (NeurIPS 2026; oral at AIWILD@ICML 2026)",
          detail:
            "A systematic multi-dimensional testing suite extending Greenblatt et al. from a handful of scenarios to a compositional, axis-based generator.",
          links: [
            {
              text: "OpenReview",
              href: "https://openreview.net/forum?id=vFqn3kCuYV",
            },
          ],
        },
        {
          label: "AM-Bench — Agentic Misalignment (NeurIPS 2026)",
          detail:
            "An extended systematic version of Lynch et al., which covers 3 scenarios; ours taxonomizes the scenario space using established theory from criminology and social psychology, including the fraud triangle.",
        },
        {
          label: "SuperSycophantic (NeurIPS 2026, then a general-science venue)",
          detail:
            "Test-time scaling of sycophancy, where prior work is almost entirely single-turn -- the multi-turn direction Noam Brown named as missing from safety evaluation.",
        },
        {
          label: "Survey of misalignment by goal-directedness",
          detail:
            "Our own survey supplies the ranking from sycophancy through strategic deception to loss of control that this sub-agenda is organized around.",
          links: [
            {
              text: "arXiv:2604.04788",
              href: "https://arxiv.org/abs/2604.04788",
            },
          ],
        },
        {
          label: "Behavioral breadth already in the pipeline",
          detail:
            "GT-HarmBench and its long-context extension, LiveHumanRightsBench on sycophancy under legal debate, When Agents Lie on premeditated deception in repeated games, and Evaluating Second-Order Bias through Epistemic Entitlement (Findings of EMNLP 2026).",
        },
      ],
    },
  },
  {
    id: "p1.1.3",
    number: "Part 1.1.3",
    title: "Adversarial Defense",
    depth: 3,
    parent: "p1.1",
    summary:
      "Weight-level defenses that survive tampering, scaled to large models and strong agentic " +
      "attacks, then deployed to frontier and European open-weight models.",
    trackRecord: {
      lede: "This is the sub-agenda with the longest publication record: four peer-reviewed results across EMNLP, ICML and NeurIPS establishing that defenses at the level of the weights beat adversarial training.",
      bullets: [
        {
          label: "Simko et al., EMNLP 2025",
          detail:
            "Contrastive learning for harmful-use mitigation; substantially lowers attack success rates against prompt-level attacks.",
          links: [
            {
              text: "ACL Anthology",
              href: "https://aclanthology.org/2025.emnlp-main.1430/",
            },
          ],
        },
        {
          label: "Simko et al., ICML 2026 — honeypot training",
          detail:
            "Addresses the residual failures by making a successful attack much less useful to the adversary, rather than only rarer.",
          links: [
            {
              text: "paper",
              href: "https://drive.google.com/file/d/1SS0R_ah7mOqSgZHkOViqAFA7YbLOVQLj/view?usp=sharing",
            },
          ],
        },
        {
          label: "Ozdincer et al., 2026 — weight-level defenses for agentic prompt injection",
          detail:
            "Carried into NeurIPS 2026 as Weight-Level Defenses Improve LLM Agent Adversarial Robustness (Memo, Samuel, Zhijing Jin, Bernhard Schölkopf).",
          links: [
            {
              text: "paper",
              href: "https://drive.google.com/file/d/1BC_r4ca7CPmFR6d2QzcXe0esuYp8paKH/view?usp=sharing",
            },
          ],
        },
        {
          label: "Hossain et al., 2026 — tamper-resistance stress benchmarking",
          detail:
            "Supports safer open-weight releases by stress-testing whether safeguards survive removal attempts on the weights.",
          links: [
            {
              text: "arXiv:2602.06911",
              href: "https://arxiv.org/pdf/2602.06911v2",
            },
          ],
        },
        {
          label: "Current cycle: five more in submission",
          detail:
            "RepPO (representation preference optimization), Predictive Representation Alignment for Robust LLM Safety, diffusion concept-erasure defense with contrastive representation learning, adversarial robustness with RLVR + triplet loss, and MoE LLM unlearning -- the base that the proposed 5-10 FTE team scales.",
        },
      ],
    },
  },
  {
    id: "p1.1.4",
    number: "Part 1.1.4",
    title: "Science of Generalization",
    depth: 3,
    parent: "p1.1",
    summary:
      "A causal account of how models generalize: diagnose representational entanglement, route " +
      "gradients to respect mechanism boundaries, and forecast training-time phase transitions.",
    trackRecord: {
      lede: "The causal machinery this sub-agenda needs is the lab's founding specialism, and the entanglement diagnostics it proposes are already being measured on real fine-tuning failures.",
      bullets: [
        {
          label: "Causal Foundational Models (ICLR 2026 submission)",
          detail:
            "Furkan, Luke, Dehan and Zhijing Jin on structural-causal-model-grounded foundation models -- the controlled synthetic worlds Objective 1 depends on.",
        },
        {
          label:
            "How Do Language Models Forget Facts? Decomposing Suppression and Erosion (ICLR 2026 submission)",
          detail:
            "Vedant, Florent, Bernhard Schölkopf and Zhijing Jin separate two mechanisms of fine-tuning spillover that behavioral testing reports as one, which is exactly the entanglement diagnostic Objective 1 asks for.",
        },
        {
          label: "Learning Exceptions Without Overwriting the Rule",
          detail:
            "Vincent and Vedant on coherence, reuse and containment from modular MLPs through to fine-tuned LLMs -- mechanism-preserving adaptation in the controlled setting first, as Objective 2 proposes.",
        },
        {
          label: "Training Dynamics of Causal Reasoning in LLMs (with MPI-IS)",
          detail:
            "Rahul and Moritz track when causal-reasoning capability appears during training -- the trajectory-level view Objective 3 builds its early-warning indicators on.",
        },
        {
          label: "Supporting work",
          detail:
            "Causal Discovery with LLMs, Causal Finetuning, Transfer-Aware Curriculum Learning for RL, and Unsupervised Elicitation of Cross-Lingual Transfer in Math Reasoning, which tests whether an elicited capability survives a distribution shift the model was never trained on.",
        },
      ],
    },
  },
  {
    id: "p1.1.5",
    number: "Part 1.1.5",
    title: "AI Interpretability",
    depth: 3,
    parent: "p1.1",
    summary:
      "Generalizable interp on two axes: systematic theory-grounded datasets, and consistency " +
      "checks across probing, SAEs, CLTs and activation oracles rather than one method per claim.",
    trackRecord: {
      lede: "Interpretability is the lab's densest output -- around twenty papers in the current cycle -- and it includes the tooling another group would need to reproduce our cross-method consistency checks.",
      bullets: [
        {
          label: "Concept-Targeted Attribution (EMNLP 2026)",
          detail:
            "Grounds linear-probe performance in circuit-level mechanisms via attribution graphs, showing probe-targeted and logit-targeted circuits are functionally distinct, and that models form concentrated internal encodings of safety-critical concepts such as toxicity even when those concepts are bottlenecked out of the generated tokens.",
          links: [
            {
              text: "paper",
              href: "https://drive.google.com/file/d/1eqbCvj3q4GQ1Xw4KvRXepe3eB3A_mjzM/view?usp=sharing",
            },
          ],
        },
        {
          label: "CLT-Forge (EMNLP 2026 Demo)",
          detail:
            "A scalable open library for cross-layer transcoders and attribution graphs, by nine authors including Florent Draye, Abir Harrasse, Vedant Palit, Zhijing Jin and Bernhard Schölkopf. Released tooling is what makes the cross-method comparison programme reproducible outside the lab.",
        },
        {
          label: "Cross-method consistency, already published",
          detail:
            "Improving the Consistency of LLM Interpretability by Showing the Equivalence of Probes and Circuit Graphs (EMNLP 2026) is the first paper of the consistency-check agenda, not a proposal for one.",
        },
        {
          label: "Scale and family coverage",
          detail:
            "Tracing Multilingual Representations with Cross-Layer Transcoders (EMNLP 2026), Computation Graph Recovery from Chain-of-Thought (EMNLP 2026), Fluid Representations in Reasoning Models (Findings of EMNLP 2026), STRIDE, Riemannian Manifold Steering, and deception probing at Llama-70B -- the multi-model, multi-family breadth whose absence the field is criticized for.",
        },
        {
          label: "Applied to the misalignment testbeds",
          detail:
            "AF-Arena, AM-Bench and SuperSycophantic are built as interp testbeds as well as behavioral ones, which is the dual-purpose design this sub-agenda argues for.",
        },
      ],
    },
  },
  {
    id: "p1.2",
    number: "Part 1.2",
    title: "When agents interact with society",
    depth: 2,
    summary:
      "2 technical leads and ~20 researchers on power concentration: measure it, and test whether " +
      "AI entering government adds friction or strips it away. Rough plan: 3M personnel + 2M compute.",
    trackRecord: {
      lede: "The lab has an existing measurement line on power concentration and an existing benchmark line on coup-aiding, both staffed and submitting before this proposal.",
      bullets: [
        {
          label: "A EuroSafeAI co-founder maps the field",
          detail:
            "Extreme power concentration now ranks second on 80,000 Hours' problem profiles, on work mapping the space by a EuroSafeAI co-founder.",
        },
        {
          label: "Four papers in the current cycle",
          detail:
            "Measuring the Rhetoric of Power Concentration (ARR), CoupBench, Simulating Democratic Deliberation (Findings of EMNLP 2026) and Evaluating LLM Preferences across Social Issues with Elections (EMNLP 2026).",
        },
      ],
    },
  },
  {
    id: "p1.2.1",
    number: "Part 1.2.1",
    title: "Power Concentration Indicators (public dashboard)",
    depth: 3,
    parent: "p1.2",
    summary:
      "An Epoch-AI-register dashboard of measured proxies for power concentration, organized by " +
      "Mann's sources of social power. A citable v0 at twelve months, maintained thereafter.",
    trackRecord: {
      lede: "We have already built and published measurement instruments for two of the five proxy domains, which is what separates a dashboard we can ship at twelve months from one we would have to start.",
      bullets: [
        {
          label: "Measuring the Rhetoric of Power Concentration (ARR, ~90%)",
          detail:
            "David G, Arka, Kem and Leyla: political speech as a tracked indicator of institutional weakness -- a working ideological-domain proxy with a real corpus behind it.",
        },
        {
          label: "Simulating Democratic Deliberation (Findings of EMNLP 2026)",
          detail:
            "Ryan Faulkner, Stanisław Szufa, Daniel Hoyer, Roland Bouffanais, Joel Z Leibo and Zhijing Jin on representing pluralistic preferences through electoral systems in multi-agent LLMs, with external collaborators from the social-simulation and computational-social-choice communities.",
        },
        {
          label: "Evaluating LLM Preferences across Social Issues with Elections (EMNLP 2026)",
          detail:
            "The political-domain proxy: what model preferences actually are, measured with an electoral instrument rather than asserted.",
        },
        {
          label: "Preserving Historical Truth (EMNLP 2026)",
          detail:
            "Detecting historical revisionism in LLMs, with Francesco Ortu, Joeun Yook, Alberto Cazzaniga and Rada Mihalcea -- content-provenance measurement, and a standing external collaboration.",
        },
        {
          label: "Interpretability applied to the same question",
          detail:
            "IF Analysis on Democratic vs. Authoritarian (EMNLP 2026) traces the internal basis of the model behavior the dashboard would otherwise only observe from outside.",
        },
      ],
    },
  },
  {
    id: "p1.2.2",
    number: "Part 1.2.2",
    title: "CoupBench",
    depth: 3,
    parent: "p1.2",
    summary:
      "A benchmark of AI responses to coup-aiding requests, labelled by construction from a " +
      "civil-military-relations pathway taxonomy, then extended to jailbreaks and mitigations.",
    trackRecord: {
      lede: "CoupBench is already in submission with a named lead, and the two capabilities it depends on -- labels derived by construction, and institution-level mitigations -- are both lines we have published in.",
      bullets: [
        {
          label: "CoupBench (in submission, ~70%)",
          detail:
            "Led by Pepijn: a statutory core of 50-100 high-precision items, a country-agnostic pathway tier instantiated from the Cline Center Coup d'État Project's 1,161 events crossed with our pathway taxonomy, and a contested dual-use tier reported with expert dispersion.",
        },
        {
          label: "CoupSim",
          detail:
            "The mitigation half -- how to produce coup-proof automated institutions -- so the benchmark arrives with something to do about a bad score.",
        },
        {
          label: "Labels by construction, demonstrated elsewhere",
          detail:
            "AF-Arena and AM-Bench already derive scenario labels from an established theoretical taxonomy rather than from annotator intuition, which is the same construction the CoupBench tiers use.",
        },
        {
          label: "Institution-level mitigation experience",
          detail:
            "Position: Multi-Agent AI Systems Need Institutional Design, Not Just Model-Level Alignment (NeurIPS 2026) and the sanctioning-mechanism work supply the institutional register that the whistleblowing-to-an-inspector-general mitigation is written in.",
        },
      ],
    },
  },
  {
    id: "p1.2.4",
    number: "Part 1.2.4",
    title: "EU AI Bench: Mapping EU AI Law into Actionable Benchmark Scores",
    depth: 3,
    parent: "p1.2",
    summary:
      "Map legal clauses of the EU code of practice into measurable benchmark scores, so a " +
      "non-technical regulator can track whether developers are meeting their commitments.",
    trackRecord: {
      lede: "This one has a running demo and public code, not a design: the legal-framework mapping and a certificate service are both already built.",
      bullets: [
        {
          label: "AI Safety Certificate — live demo",
          detail: "A working service that renders the mapping as a per-model certificate.",
          links: [
            {
              text: "safe.eu/certificate",
              href: "https://safe.eu/certificate",
            },
          ],
        },
        {
          label: "Open-source implementation",
          detail: "Code, high-level explanations and a run guide, public on GitHub.",
          links: [
            {
              text: "github.com/jacobemmerson/certificate",
              href: "https://github.com/jacobemmerson/certificate/tree/main",
            },
          ],
        },
        {
          label: "Legal framework document",
          detail:
            "The clause-to-benchmark mapping itself, written up as a standing reference (20260520).",
          links: [
            {
              text: "framework doc",
              href: "https://docs.google.com/document/d/1aSwPmfv_a21oXNligVegFRCCMYvdvRJe1Vy2LcqyOa8/edit",
            },
          ],
        },
        {
          label: "The benchmarks the clauses map onto are ours",
          detail:
            "GT-HarmBench, AF-Arena, AM-Bench and the adversarial-defense suite are lab-built, so a clause maps to a score we control and can keep current.",
        },
      ],
    },
  },
  {
    id: "p1.3",
    number: "Part 1.3",
    title: "When agents interact with each other",
    depth: 2,
    summary:
      "2 technical leads and ~20 researchers on multi-agent safety with multiple principals, not " +
      "one orchestrator with sub-agents. Rough plan: 3M personnel + 2M compute.",
    trackRecord: {
      lede: "Multi-agent is the lab's second-largest line and its most externally collaborative, with roughly fifteen papers in the current cycle.",
      bullets: [
        {
          label: "External senior collaborators already engaged",
          detail:
            "Vincent Conitzer, Joel Z Leibo, Emanuele La Malfa and Samuele Marro (Oxford), Roland Bouffanais and Stanisław Szufa are co-authors on the current multi-agent papers.",
        },
        {
          label: "Both halves staffed",
          detail:
            "The evaluation half (Part 1.3.1) and the game-theoretic half (Part 1.3.2) each have five or more papers in submission, listed under their own sections below.",
        },
      ],
    },
  },
  {
    id: "p1.3.1",
    number: "Part 1.3.1",
    title: "Extend frontier evals into multi-agent versions",
    depth: 3,
    parent: "p1.3",
    summary:
      "Take frontier single-agent evaluations into settings with several principals, where each " +
      "agent holds full delegation from its own human owner.",
    trackRecord: {
      lede: "We have already ported our own safety evaluations into multi-principal settings, and found failure modes the single-agent versions do not show.",
      bullets: [
        {
          label: "GT-HarmBench and its long-context extension (NeurIPS 2026 / ICLR 2026)",
          detail:
            "Harm evaluation in game-theoretic settings with multiple principals, now being extended to long horizons -- directly the multi-agent port this section proposes.",
        },
        {
          label: "When Agents Lie (NeurIPS 2026)",
          detail:
            "Premeditation, persistence and exploitation in repeated games, with Vincent Conitzer -- deception measured between agents rather than towards a user.",
        },
        {
          label: "Entropy Collapse in Agentic Social Media",
          detail:
            "What happens to a population of delegated agents left to interact at scale; rejected at EMNLP 2026 and in revision, reported here because the negative result is part of the record.",
        },
        {
          label: "Revisiting Multi-Agent Debate as Test-Time Scaling",
          detail:
            "When multi-agent structure actually helps and when it does not -- the control condition the rest of the agenda needs.",
        },
        {
          label: "Harnesses in production, not only in simulation",
          detail:
            "WordPlay and AdminBot are lab-built multi-agent systems in daily use, giving the group real multi-principal deployments to evaluate.",
        },
      ],
    },
  },
  {
    id: "p1.3.2",
    number: "Part 1.3.2",
    title: "Game-theoretic lens of agent interaction",
    depth: 3,
    parent: "p1.3",
    summary:
      "Treat agent interaction as mechanism design: incomplete contracts, sanctioning, open-source " +
      "game theory, and institutional rather than model-level alignment.",
    trackRecord: {
      lede: "This is a mature line with a NeurIPS position paper, an Oxford collaboration, and a methods paper under review at JMLR.",
      bullets: [
        {
          label: "The Case for Moral Agents (NeurIPS 2026)",
          detail:
            "Angelo Huang, Charlie Tharas, Samuele Marro, Emanuele La Malfa and Zhijing Jin: prosocial agents dominate homo economicus under incomplete contracts -- a positive result, with Oxford.",
        },
        {
          label:
            "Position: Multi-Agent AI Systems Need Institutional Design, Not Just Model-Level Alignment (NeurIPS 2026)",
          detail:
            "The agenda-setting paper for this section, with seven lab authors plus an external co-author.",
        },
        {
          label: "Transparency in Open Source Game Theory (JMLR, under review)",
          detail:
            "Colomban, Pepijn and Riccardo -- the theory track, at a journal venue rather than a workshop.",
        },
        {
          label: "Mechanism design, empirically",
          detail:
            "Sanctioning variants (mechanism design and incentive structure determine collective outcomes), Evaluating Cooperation in LLM Social Groups through Elected Leadership (ARR), and When Ethics and Payoffs Diverge (EMNLP 2026).",
        },
        {
          label: "Training for cooperation",
          detail:
            "MoralGym, RL for game theory, Evolutionary pressures for cooperative language models, and The Evolution of Cooperation in Artificial Systems -- the post-training half, so the section produces interventions and not only measurements.",
        },
      ],
    },
  },
];

export const GRANT_SECTION_BY_ID: Readonly<Record<string, GrantSection>> = Object.fromEntries(
  GRANT_SECTIONS.map((section) => [section.id, section]),
);

/** The sections that actually carry papers and a claim: everything below the working-group level. */
export function leafSections(): readonly GrantSection[] {
  return GRANT_SECTIONS.filter((section) => section.depth > 2);
}
