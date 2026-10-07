import torch
from torch import nn

from .bert_encoder import DualEncoderOutput, TokenEncoding


class DualTextProjection(nn.Module):
    """Project both text branches from BERT space to stance-module space."""

    def __init__(self, input_dim: int = 768, output_dim: int = 384):
        super().__init__()

        if input_dim <= 0 or output_dim <= 0:
            raise ValueError("Feature dimensions must be positive")

        # Two independent parameter sets.
        self.claim_projection = nn.Linear(input_dim, output_dim)
        self.evidence_projection = nn.Linear(input_dim, output_dim)

    def forward(self, encoded: DualEncoderOutput) -> DualEncoderOutput:
        claim = self._project(encoded.claim, self.claim_projection)
        evidence = self._project(encoded.evidence, self.evidence_projection)

        if claim.hidden_states.shape[0] != evidence.hidden_states.shape[0]:
            raise ValueError("Claim and evidence batch sizes must match")

        return DualEncoderOutput(claim=claim, evidence=evidence)

    @staticmethod
    def _project(
        encoded: TokenEncoding,
        layer: nn.Linear,
    ) -> TokenEncoding:
        features = encoded.hidden_states
        mask = encoded.attention_mask

        if features.ndim != 3:
            raise ValueError("Features must have shape [B, L, H]")
        if features.shape[-1] != layer.in_features:
            raise ValueError(
                f"Expected feature dimension {layer.in_features}, "
                f"got {features.shape[-1]}"
            )
        if mask.shape != features.shape[:2]:
            raise ValueError("Mask must match feature dimensions [B, L]")
        if mask.dtype != torch.bool:
            raise TypeError("Mask must be boolean: True means a valid token")
        if mask.device != features.device:
            raise ValueError("Features and mask must be on the same device")

        projected = layer(features)

        # Linear bias can make padded positions nonzero; clear them again.
        projected = projected.masked_fill(~mask.unsqueeze(-1), 0.0)

        return TokenEncoding(
            hidden_states=projected,
            attention_mask=mask,
        )
