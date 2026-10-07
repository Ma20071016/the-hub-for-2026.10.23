"""Behavioral checks for frozen dual encoding; no downloaded weights required.

Run from the project root: python -B -m unittest discover -s tests
"""

import tempfile
import unittest
from pathlib import Path

import torch
from torch import nn
from transformers import BertConfig, BertModel

from models.bert_encoder import FrozenBertDualEncoder


class FrozenBertDualEncoderTests(unittest.TestCase):
    """Use a real, tiny BERT to exercise masks, gradients, and dropout."""

    def setUp(self):
        torch.manual_seed(17)
        config = BertConfig(
            vocab_size=31,
            hidden_size=24,
            num_hidden_layers=1,
            num_attention_heads=4,
            intermediate_size=48,
            max_position_embeddings=32,
            type_vocab_size=2,
            hidden_dropout_prob=0.4,
            attention_probs_dropout_prob=0.4,
            pad_token_id=0,
        )
        self.encoder = FrozenBertDualEncoder(
            BertModel(config, add_pooling_layer=False)
        )

    @staticmethod
    def inputs(batch_size=2, length=5):
        ids = torch.arange(1, length + 1).repeat(batch_size, 1)
        mask = torch.ones_like(ids)
        if batch_size > 1:
            ids[-1, -2:] = 0
            mask[-1, -2:] = 0
        return {
            "input_ids": ids,
            "attention_mask": mask,
            "token_type_ids": torch.zeros_like(ids),
        }

    def test_two_branches_match_independent_calls_to_shared_bert(self):
        claim = self.inputs(length=5)
        evidence = self.inputs(length=8)
        evidence["input_ids"][:, 0] = 17
        result = self.encoder(claim, evidence)

        self.assertEqual(self.encoder.hidden_size, 24)
        for inputs, encoded in [(claim, result.claim), (evidence, result.evidence)]:
            with torch.no_grad():
                expected = self.encoder.bert(**inputs).last_hidden_state
            valid = inputs["attention_mask"].bool()
            expected = expected.masked_fill(~valid.unsqueeze(-1), 0.0)
            torch.testing.assert_close(encoded.hidden_states, expected)
            self.assertEqual(encoded.attention_mask.dtype, torch.bool)
            self.assertTrue(torch.equal(encoded.attention_mask, valid))
            self.assertFalse(encoded.hidden_states.requires_grad)
            self.assertEqual(
                tuple(encoded.hidden_states.shape), (*inputs["input_ids"].shape, 24)
            )

    def test_batch_sizes_and_optional_segment_ids(self):
        for batch_size in [1, 4]:
            with self.subTest(batch_size=batch_size):
                claim = self.inputs(batch_size, length=4)
                evidence = self.inputs(batch_size, length=7)
                del claim["token_type_ids"]
                del evidence["token_type_ids"]
                claim["attention_mask"] = claim["attention_mask"].bool()
                result = self.encoder(claim, evidence)
                self.assertEqual(tuple(result.claim.hidden_states.shape), (batch_size, 4, 24))
                self.assertEqual(tuple(result.evidence.hidden_states.shape), (batch_size, 7, 24))

    def test_parent_training_preserves_frozen_deterministic_bert(self):
        parent = nn.Module()
        parent.add_module("encoder", self.encoder)
        parent.train()

        self.assertFalse(self.encoder.bert.training)
        self.assertTrue(all(not module.training for module in self.encoder.bert.modules()))
        self.assertTrue(all(not p.requires_grad for p in self.encoder.bert.parameters()))
        first = self.encoder(self.inputs(), self.inputs(length=7))
        second = self.encoder(self.inputs(), self.inputs(length=7))
        torch.testing.assert_close(first.claim.hidden_states, second.claim.hidden_states, rtol=0, atol=0)
        torch.testing.assert_close(first.evidence.hidden_states, second.evidence.hidden_states, rtol=0, atol=0)

    def test_outputs_support_downstream_training(self):
        """Frozen features must work with autograd, unlike inference tensors."""
        head = nn.Linear(24, 3)
        result = self.encoder(self.inputs(), self.inputs(length=7))
        logits = head(result.claim.hidden_states[:, 0] + result.evidence.hidden_states[:, 0])
        nn.functional.cross_entropy(logits, torch.tensor([0, 2])).backward()

        self.assertIsNotNone(head.weight.grad)
        self.assertTrue(torch.isfinite(head.weight.grad).all().item())
        self.assertGreater(head.weight.grad.abs().sum().item(), 0.0)
        self.assertTrue(all(p.grad is None for p in self.encoder.bert.parameters()))

    def test_padding_does_not_change_valid_token_representations(self):
        short = self.inputs(batch_size=1, length=5)
        padded = {
            "input_ids": torch.cat([short["input_ids"], torch.tensor([[27, 26, 25]])], dim=1),
            "attention_mask": torch.tensor([[1, 1, 1, 1, 1, 0, 0, 0]]),
            "token_type_ids": torch.zeros(1, 8, dtype=torch.long),
        }
        result = self.encoder(short, padded)
        torch.testing.assert_close(
            result.claim.hidden_states,
            result.evidence.hidden_states[:, :5],
            rtol=1e-5,
            atol=1e-6,
        )
        self.assertEqual(torch.count_nonzero(result.evidence.hidden_states[:, 5:]).item(), 0)

    def test_invalid_inputs_fail_explicitly(self):
        cases = []

        def add_case(name, key, value):
            inputs = self.inputs()
            inputs[key] = value
            cases.append((name, inputs))

        add_case("floating token ids", "input_ids", self.inputs()["input_ids"].float())
        add_case("non-tensor token ids", "input_ids", [[1, 2, 3, 4, 5]] * 2)
        add_case("negative token id", "input_ids", torch.full((2, 5), -1, dtype=torch.long))
        add_case("token id outside vocabulary", "input_ids", torch.full((2, 5), 31, dtype=torch.long))
        add_case("nonbinary mask", "attention_mask", torch.full((2, 5), 2, dtype=torch.long))
        add_case("fractional mask", "attention_mask", torch.full((2, 5), 0.5))
        add_case("NaN mask", "attention_mask", torch.full((2, 5), float("nan")))
        add_case("all padding", "attention_mask", torch.zeros(2, 5, dtype=torch.long))
        add_case("one all-padding sample", "attention_mask", torch.tensor([[1] * 5, [0] * 5]))
        add_case("mask shape mismatch", "attention_mask", torch.ones(2, 4, dtype=torch.long))
        add_case("rank-one token ids", "input_ids", torch.ones(5, dtype=torch.long))
        add_case("segment shape mismatch", "token_type_ids", torch.zeros(2, 4, dtype=torch.long))
        add_case("floating segment ids", "token_type_ids", torch.zeros(2, 5))
        add_case("segment id outside vocabulary", "token_type_ids", torch.full((2, 5), 2, dtype=torch.long))
        add_case("negative segment id", "token_type_ids", torch.full((2, 5), -1, dtype=torch.long))
        add_case("unexpected labels field", "labels", torch.tensor([0, 1]))
        missing_mask = self.inputs()
        del missing_mask["attention_mask"]
        cases.append(("missing attention mask", missing_mask))
        too_long = {
            "input_ids": torch.ones(2, 33, dtype=torch.long),
            "attention_mask": torch.ones(2, 33, dtype=torch.long),
        }
        cases.append(("position outside BERT limit", too_long))
        for shape in [(0, 5), (2, 0)]:
            cases.append((f"empty input {shape}", {
                "input_ids": torch.ones(shape, dtype=torch.long),
                "attention_mask": torch.ones(shape, dtype=torch.long),
            }))

        for name, invalid in cases:
            with self.subTest(case=name):
                with self.assertRaises((TypeError, ValueError)):
                    self.encoder(invalid, self.inputs(length=7))

    def test_mismatched_branch_batch_sizes_fail(self):
        with self.assertRaises(ValueError):
            self.encoder(self.inputs(batch_size=1), self.inputs(batch_size=2))

    def test_mismatched_devices_fail_before_tensor_operations(self):
        inputs = self.inputs()
        inputs["attention_mask"] = inputs["attention_mask"].to("meta")
        with self.assertRaises(ValueError):
            self.encoder(inputs, self.inputs(length=7))

    def test_local_safetensors_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            self.encoder.bert.save_pretrained(directory, safe_serialization=True)
            restored = FrozenBertDualEncoder.from_pretrained(Path(directory))
            self.assertIsNone(restored.bert.pooler)
            self.assertFalse(restored.bert.training)
            actual = restored(self.inputs(), self.inputs(length=7))
            expected = self.encoder(self.inputs(), self.inputs(length=7))
            torch.testing.assert_close(actual.claim.hidden_states, expected.claim.hidden_states)
            torch.testing.assert_close(actual.evidence.hidden_states, expected.evidence.hidden_states)


if __name__ == "__main__":
    unittest.main()
