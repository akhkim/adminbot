# PaperFlow — revised

```mermaid
%% Revised from the original. Two changes, both in the arXiv branch:
%%   1. ZP [Zhijing review] removed — Zhijing's involvement halves to one gate, GT
%%      (also dropped from the `rel` class list)
%%   2. both of ZP's inbound edges (AK, CM) now land on PK
%%   3. CA [Conference attendance] and RM [Reimbursement reminders] added off the accept
%%      path — travel is triggered by acceptance and runs parallel to camera ready, not
%%      after it. Guarded on first / co-first authorship. Checklist below the diagram.
%% PK therefore has two inbound edges and is an OR-join: AK alone OR CM alone is enough.
%% This matters because a reject prunes CM — under AND, branch 3 would deadlock
%% permanently and silently, and the preprint could never be posted.
flowchart TD
    BR[Brainstorm doc] -->|Register with AdminBot| OV[Overleaf draft]
    OV --> PM[PaperMentor review]
    PM -->|Merge low cost fixes| FX[Fixes merged]
    FX -->|Compiles cleanly| PDF[Compiled paper PDF ready]

    PDF -->|Branch 1| SL[Slides]
    PDF -->|Branch 2| XD[X post draft]
    PDF -->|Branch 2| LI[LinkedIn post draft]
    PDF -->|Branch 3| DR[Internal Drive PDF]
    PDF -->|Branch 4| CK[Final submission checks]

    SL --> PO[Poster]
    SL --> TV[Talk video]

    XD -->|Email round| CP[Coauthor feedback]
    LI -->|Email round| CP
    CP --> SF[Final social draft]

    DR --> DA[Drive PDF, arXiv version]
    DA --> AK[Author list and acknowledgements]
    AK --> PK[arXiv package prepared]
    PK -->|Prepared is not permission| GT{Zhijing explicit yes}
    GT -->|Not yet| PK
    GT -->|Public URL| JN
    GT --> BE[Backend spreadsheet updated -optional]

    CK --> SB[Submitted to venue]
    SB -->|Submission id registered| RV[Reviews out]
    RV --> RB{Rebuttal window}
    RB -->|Yes| RS[Rebuttal submitted]
    RB -->|No| DC[Decision recorded]
    RS --> DC
    DC --> AC{Accepted}
    AC -->|Accept| CM[Camera ready]
    AC -->|Accept, first or co-first author| CA[Conference attendance]
    AC -->|Reject| RJ[Rejected]
    CA -->|After conference| RM[Reimbursement reminders]
    CM -->|Still needs the gate| PK
    RJ -.->|Revise, new venue, same record| OV

    SF --> JN{Both inputs present}
    JN -->|Yes| PS[Publish X and LinkedIn]

    classDef pres fill:#EEEDFE,stroke:#534AB7,color:#26215C
    classDef soc fill:#FAECE7,stroke:#993C1D,color:#4A1B0C
    classDef rel fill:#E1F5EE,stroke:#0F6E56,color:#04342C
    classDef conf fill:#FBEAF0,stroke:#993556,color:#4B1528
    classDef gate fill:#FCEBEB,stroke:#A32D2D,color:#501313
    classDef hub fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A

    class BR,OV,PM,FX,PDF hub
    class SL,PO,TV pres
    class XD,LI,CP,SF,PS soc
    class DR,DA,AK,PK,BE rel
    class CK,SB,RV,RB,RS,DC,AC,CM,RJ,CA,RM conf
    class GT,JN gate
```

## Conference attendance — what `CA` covers

Triggered on acceptance, for the **first author or a co-first author**. All of it runs in
parallel with camera ready, not after it — flights and hotels get expensive if this waits.

- Read the reimbursement policy in the guidebook **first**, before booking anything
- Register for the conference, book flight and Airbnb or hotel
- Create or join the conference Slack channel — format `#conf-icml-2026`
- *Optional but suggested:* coordinate with other members on shared flight times and
  Airbnb, so the trip doubles as team building
- Early user: Memo (for COLM)
- Use *Jinesis Lab: Quick Pointers of Research in 2026* extensively

`RM` fires **after** the conference, not before — that is the whole reason it is a separate
node rather than a bullet on `CA`. Reimbursement can only start once the receipts exist.
