"""Shared, frozen BERT for the claim and evidence branches of the text model.

The two texts are encoded independently by one parameter set. This module
returns token-level features; pooling and cross-text classification belong to
the downstream ESCNet stance module.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import torch
from torch import Tensor, nn
from transformers import BertModel


@dataclass(frozen=True)
class TokenEncoding:
    """One text branch: features [B, L, H] and a True-for-valid mask [B, L].

    Special tokens such as [CLS] and [SEP] remain valid. Padding feature vectors
    are zero, but downstream attention must still use the mask: zero vectors
    alone do not prevent padded positions from receiving attention probability.
    """

    hidden_states: Tensor
    attention_mask: Tensor


@dataclass(frozen=True)
class DualEncoderOutput:
    """Paired encodings with the same batch size and independent text lengths."""

    claim: TokenEncoding
    evidence: TokenEncoding


class FrozenBertDualEncoder(nn.Module):
    """Encode both branches with a single frozen Chinese BERT.

    Args:
        bert: An initialized BertModel. Production code loads the pinned local
            pretrained snapshot via ``from_pretrained``. Tests may inject a tiny
            randomly initialized BertModel without downloading any weights.

    ``train()`` deliberately leaves BERT in evaluation mode. ``no_grad()`` stops
    encoder gradients while producing ordinary tensors that a trainable linear
    projection can save for its own backward pass.
    """

    def __init__(self, bert: BertModel) -> None:
        super().__init__()
        if not isinstance(bert, BertModel):
            raise TypeError("bert must be a transformers.BertModel")
        self.bert = bert
        self.bert.requires_grad_(False)
        self.bert.eval()

    @classmethod
    def from_pretrained(cls, model_path: str | Path) -> "FrozenBertDualEncoder":
        """Load a local safetensors snapshot; never download inside the model."""
        path = Path(model_path).expanduser()
        if not path.is_dir():
            raise FileNotFoundError(f"BERT snapshot directory does not exist: {path}")
        bert = BertModel.from_pretrained(
            str(path),
            local_files_only=True,
            use_safetensors=True,
            add_pooling_layer=False,
            attn_implementation="eager",
        )
        return cls(bert)

    @property
    def hidden_size(self) -> int:
        """Feature dimension H (768 for bert-base-chinese)."""
        return self.bert.config.hidden_size

    def train(self, mode: bool = True) -> "FrozenBertDualEncoder":
        """Follow the parent module's mode while keeping BERT dropout disabled."""
        super().train(mode)
        self.bert.eval()
        return self

    @torch.no_grad()
    def forward(
        self,
        claim_inputs: Mapping[str, Tensor],
        evidence_inputs: Mapping[str, Tensor],
    ) -> DualEncoderOutput:
        """Return separate token features without pooling or concatenation.

        Each input requires input_ids and attention_mask with shape [B, L].
        token_type_ids is optional. Inputs must already be on the BERT device;
        this module does not hide device transfers or accept labels/metadata.
        """
        self._validate_inputs(claim_inputs, branch="claim")
        self._validate_inputs(evidence_inputs, branch="evidence")
        if claim_inputs["input_ids"].shape[0] != evidence_inputs["input_ids"].shape[0]:
            raise ValueError("claim and evidence must have the same batch size")
        return DualEncoderOutput(
            claim=self._encode(claim_inputs),
            evidence=self._encode(evidence_inputs),
        )

    def _encode(self, inputs: Mapping[str, Tensor]) -> TokenEncoding:
        valid_mask = inputs["attention_mask"].to(dtype=torch.bool)
        output = self.bert(
            input_ids=inputs["input_ids"],
            attention_mask=valid_mask,
            token_type_ids=inputs.get("token_type_ids"),
            output_attentions=False,
            output_hidden_states=False,
            return_dict=True,
        )
        features = output.last_hidden_state.masked_fill(~valid_mask.unsqueeze(-1), 0.0)
        return TokenEncoding(hidden_states=features, attention_mask=valid_mask)

    def _validate_inputs(self, inputs: Mapping[str, Tensor], branch: str) -> None:
        """Fail at the input boundary rather than deep inside an embedding op."""
        if not isinstance(inputs, Mapping):
            raise TypeError(f"{branch}: expected a mapping of input tensors")
        required = {"input_ids", "attention_mask"}
        allowed = required | {"token_type_ids"}
        if not required.issubset(inputs):
            raise ValueError(f"{branch}: input_ids and attention_mask are required")
        if set(inputs) - allowed:
            raise ValueError(f"{branch}: unexpected input keys: {set(inputs) - allowed}")
        if any(not isinstance(value, Tensor) for value in inputs.values()):
            raise TypeError(f"{branch}: every input must be a torch.Tensor")

        ids = inputs["input_ids"]
        mask = inputs["attention_mask"]
        if ids.dtype != torch.long:
            raise TypeError(f"{branch}: input_ids must have dtype torch.long")
        if ids.ndim != 2 or min(ids.shape) == 0:
            raise ValueError(f"{branch}: input_ids must have nonempty shape [B, L]")
        if ids.shape[1] > self.bert.config.max_position_embeddings:
            raise ValueError(f"{branch}: sequence length exceeds BERT positional capacity")
        device = self.bert.get_input_embeddings().weight.device
        for key, value in inputs.items():
            if value.shape != ids.shape:
                raise ValueError(f"{branch}: {key} must match input_ids shape")
            if value.device != device:
                raise ValueError(f"{branch}: {key} is on {value.device}; BERT is on {device}")
        if mask.is_complex() or not torch.all((mask == 0) | (mask == 1)).item():
            raise ValueError(f"{branch}: attention_mask must be binary (0 or 1)")
        if not mask.to(dtype=torch.bool).any(dim=1).all().item():
            raise ValueError(f"{branch}: each sample needs at least one valid token")
        if ids.min().item() < 0 or ids.max().item() >= self.bert.config.vocab_size:
            raise ValueError(f"{branch}: input_ids contain an out-of-vocabulary index")

        if "token_type_ids" in inputs:
            types = inputs["token_type_ids"]
            if types.dtype != torch.long:
                raise TypeError(f"{branch}: token_type_ids must have dtype torch.long")
            if types.min().item() < 0 or types.max().item() >= self.bert.config.type_vocab_size:
                raise ValueError(f"{branch}: token_type_ids are outside BERT type vocabulary")
