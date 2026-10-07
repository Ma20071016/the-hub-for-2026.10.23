"""Shared-prototype stance components adapted from ESCNet's text branch."""

from dataclasses import dataclass

import torch
from torch import Tensor, nn

from .bert_encoder import DualEncoderOutput, TokenEncoding


class PrototypeCrossAttention(nn.Module):
    """Use prototype queries to extract information from text tokens.

    Inputs:
        queries:    [B, M, D], prototype representations.
        context:    [B, L, D], projected text representations.
        valid_mask: [B, L], True for valid text positions.

    Output:
        Tensor of shape [B, M, D].
    """

    def __init__(
        self,
        dim: int = 384,
        num_heads: int = 6,
        dropout: float = 0.3,
    ) -> None:
        super().__init__()

        if dim <= 0 or num_heads <= 0:
            raise ValueError("dim and num_heads must be positive")
        if dim % num_heads != 0:
            raise ValueError("dim must be divisible by num_heads")

        self.dim = dim
        self.num_heads = num_heads
        self.head_dim = dim // num_heads
        self.scale = self.head_dim ** -0.5

        # Match the original attention: Q/K/V projections have no bias.
        self.to_q = nn.Linear(dim, dim, bias=False)
        self.to_kv = nn.Linear(dim, dim * 2, bias=False)

        self.output = nn.Sequential(
            nn.Linear(dim, dim),
            nn.Dropout(dropout),
        )

    def _split_heads(self, features: Tensor) -> Tensor:
        """[B, N, D] -> [B, heads, N, head_dim]."""
        batch_size, length, _ = features.shape
        return features.reshape(
            batch_size, length, self.num_heads, self.head_dim
        ).transpose(1, 2)

    def forward(
        self,
        queries: Tensor,
        context: Tensor,
        valid_mask: Tensor,
    ) -> Tensor:
        self._validate_inputs(queries, context, valid_mask)

        # Clear padding before projecting keys and values.
        context = context.masked_fill(~valid_mask.unsqueeze(-1), 0.0)

        query = self._split_heads(self.to_q(queries))
        key, value = self.to_kv(context).chunk(2, dim=-1)
        key = self._split_heads(key)
        value = self._split_heads(value)

        # [B, heads, M, L]: each prototype scores every text token.
        scores = torch.matmul(query, key.transpose(-2, -1)) * self.scale

        # Padding must receive zero attention probability.
        scores = scores.masked_fill(
            ~valid_mask[:, None, None, :],
            float("-inf"),
        )
        attention = scores.softmax(dim=-1)

        # [B, heads, M, head_dim] -> [B, M, D].
        attended = torch.matmul(attention, value)
        attended = attended.transpose(1, 2).reshape(
            queries.shape[0], queries.shape[1], self.dim
        )

        return self.output(attended)

    def _validate_inputs(
        self,
        queries: Tensor,
        context: Tensor,
        valid_mask: Tensor,
    ) -> None:
        if queries.ndim != 3 or context.ndim != 3:
            raise ValueError("queries and context must have shape [B, N, D]")
        if min(queries.shape) == 0 or min(context.shape) == 0:
            raise ValueError("Empty batches or sequences are not supported")
        if queries.shape[0] != context.shape[0]:
            raise ValueError("Query and context batch sizes must match")
        if queries.shape[-1] != self.dim or context.shape[-1] != self.dim:
            raise ValueError(f"Feature dimension must be {self.dim}")
        if valid_mask.shape != context.shape[:2]:
            raise ValueError("valid_mask must match context dimensions [B, L]")
        if valid_mask.dtype != torch.bool:
            raise TypeError("valid_mask must be boolean")
        if not queries.is_floating_point() or not context.is_floating_point():
            raise TypeError("Query and context features must be floating point")

        device = self.to_q.weight.device
        if any(t.device != device for t in (queries, context, valid_mask)):
            raise ValueError("Inputs and attention parameters must share a device")
        if not valid_mask.any(dim=1).all().item():
            raise ValueError("Each sample needs at least one valid text token")


class CrossAttentionResidual(nn.Module):
    """Pre-normalized cross-attention with a residual connection."""

    def __init__(
        self,
        dim: int = 384,
        num_heads: int = 6,
        dropout: float = 0.3,
    ) -> None:
        super().__init__()

        # Follow ESCNet: queries and context share this LayerNorm.
        self.norm = nn.LayerNorm(dim)
        self.attention = PrototypeCrossAttention(
            dim=dim,
            num_heads=num_heads,
            dropout=dropout,
        )

    def forward(
        self,
        queries: Tensor,
        context: Tensor,
        valid_mask: Tensor,
    ) -> Tensor:
        normalized_queries = self.norm(queries)
        normalized_context = self.norm(context)

        update = self.attention(
            queries=normalized_queries,
            context=normalized_context,
            valid_mask=valid_mask,
        )

        # Preserve the original queries and add information from the text.
        return queries + update


class FeedForwardResidual(nn.Module):
    """Pre-normalized feed-forward network with a residual connection."""

    def __init__(
        self,
        dim: int = 384,
        hidden_dim: int = 768,
        dropout: float = 0.3,
    ) -> None:
        super().__init__()

        if dim <= 0 or hidden_dim <= 0:
            raise ValueError("Feature dimensions must be positive")

        self.dim = dim
        self.norm = nn.LayerNorm(dim)

        # Follow ESCNet: expand, apply ReLU, then project back.
        self.feed_forward = nn.Sequential(
            nn.Linear(dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, dim),
            nn.Dropout(dropout),
        )

    def forward(self, features: Tensor) -> Tensor:
        if features.ndim != 3 or features.shape[-1] != self.dim:
            raise ValueError(
                f"Features must have shape [B, M, {self.dim}]"
            )

        update = self.feed_forward(self.norm(features))
        return features + update


@dataclass(frozen=True)
class StanceOutput:
    """Text-conditioned prototype features for both branches."""

    claim: Tensor       # [B, M, D]
    evidence: Tensor    # [B, M, D]


class SharedPrototypeStance(nn.Module):
    """One shared prototype bank and one shared stance block.

    Both branches use the same parameters, but attend to their own text.
    """

    def __init__(
        self,
        dim: int = 384,
        num_prototypes: int = 40,
        num_heads: int = 6,
        hidden_dim: int = 768,
        dropout: float = 0.3,
    ) -> None:
        super().__init__()

        if dim <= 0 or num_prototypes <= 0:
            raise ValueError("dim and num_prototypes must be positive")

        # A single trainable prototype bank, shared by both branches.
        self.prototypes = nn.Parameter(
            torch.randn(1, num_prototypes, dim)
        )

        self.attention_block = CrossAttentionResidual(
            dim=dim,
            num_heads=num_heads,
            dropout=dropout,
        )
        self.feed_forward_block = FeedForwardResidual(
            dim=dim,
            hidden_dim=hidden_dim,
            dropout=dropout,
        )

    def _encode_branch(self, branch: TokenEncoding) -> Tensor:
        features = branch.hidden_states
        batch_size = features.shape[0]

        # Expand the batch dimension without creating new parameters.
        queries = self.prototypes.expand(batch_size, -1, -1)

        # Stage 1: extract information from this branch's text.
        attended = self.attention_block(
            queries=queries,
            context=features,
            valid_mask=branch.attention_mask,
        )

        # Stage 2: transform each prototype representation.
        return self.feed_forward_block(attended)

    def forward(self, projected: DualEncoderOutput) -> StanceOutput:
        claim_features = projected.claim.hidden_states
        evidence_features = projected.evidence.hidden_states

        if claim_features.ndim != 3 or evidence_features.ndim != 3:
            raise ValueError("Both branches must have shape [B, L, D]")
        if claim_features.shape[0] != evidence_features.shape[0]:
            raise ValueError("Claim and evidence batch sizes must match")

        return StanceOutput(
            claim=self._encode_branch(projected.claim),
            evidence=self._encode_branch(projected.evidence),
        )


class StanceFusion(nn.Module):
    """Pool both branches, apply a shared projection, and concatenate."""

    def __init__(self, dim: int = 384, output_dim: int = 40) -> None:
        super().__init__()

        # The same projection is used for claim and evidence.
        self.shared_projection = nn.Linear(dim, output_dim, bias=False)

    def forward(self, stance: StanceOutput) -> Tensor:
        # Mean over prototype positions: [B, 40, 384] -> [B, 384].
        claim = stance.claim.mean(dim=1)
        evidence = stance.evidence.mean(dim=1)

        # Shared projection: [B, 384] -> [B, 40].
        claim = self.shared_projection(claim)
        evidence = self.shared_projection(evidence)

        # Combine both branches: [B, 40] + [B, 40] -> [B, 80].
        return torch.cat([claim, evidence], dim=-1)
