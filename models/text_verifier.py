"""Text-only three-class verifier using ESCNet's shared-prototype module."""

from collections.abc import Mapping
from pathlib import Path

from torch import Tensor, nn

from .bert_encoder import FrozenBertDualEncoder
from .text_projection import DualTextProjection
from .stance_transformer import SharedPrototypeStance, StanceFusion


class TextVerifier(nn.Module):
    """Encode a claim/evidence pair and return three class logits."""

    def __init__(self, bert_path: str | Path) -> None:
        super().__init__()

        self.encoder = FrozenBertDualEncoder.from_pretrained(bert_path)

        self.projection = DualTextProjection(
            input_dim=self.encoder.hidden_size,
            output_dim=384,
        )

        self.stance = SharedPrototypeStance(
            dim=384,
            num_prototypes=40,
            num_heads=6,
            hidden_dim=768,
            dropout=0.3,
        )

        self.fusion = StanceFusion(
            dim=384,
            output_dim=40,
        )

        # Class order: supports, refutes, insufficient.
        self.classifier = nn.Sequential(
            nn.Linear(80, 180),
            nn.LeakyReLU(negative_slope=0.01),
            nn.Linear(180, 3),
        )

    def forward(
        self,
        claim_inputs: Mapping[str, Tensor],
        evidence_inputs: Mapping[str, Tensor],
    ) -> Tensor:
        encoded = self.encoder(claim_inputs, evidence_inputs)
        projected = self.projection(encoded)
        stance = self.stance(projected)
        fused = self.fusion(stance)

        return self.classifier(fused)