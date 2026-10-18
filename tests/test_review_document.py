"""Review-result regression checks against the real backend module.

Run without model weights, third-party packages, or a database:
    python -B -m unittest discover -s tests -p test_review_document.py -v

Only retrieval and inference are fakes. Cleaning, sentence splitting, evidence
filtering, aggregation, counters, offsets, and callbacks run production code.
"""

from copy import deepcopy
import unittest
from unittest.mock import patch

from backend import serve
from backend.text_prepare import clean_text


def evidence(identifier, text=None, source_id=7):
    return {
        "id": identifier,
        "source_id": source_id,
        "evidence_text": text or f"证据{identifier}记载了服饰的材料和形制。",
        "object_name": f"藏品{source_id}",
        "title": f"资料{source_id}",
        "source_url": f"https://example.invalid/source/{source_id}",
        "locator": f"chars:{identifier * 10}-{identifier * 10 + 9}",
    }


def prediction(label, confidence=0.9):
    scores = {name: (1 - confidence) / 2
              for name in ("supports", "refutes", "insufficient")}
    scores[label] = confidence
    return {"label": label, "scores": scores}


class FakeVerifier:
    def __init__(self, predictions):
        self.predictions = predictions
        self.calls = []

    def predict(self, sentence, evidence_input):
        self.calls.append((sentence, evidence_input))
        # Also enforce that the actual inference input includes the object.
        header, evidence_text = evidence_input.split("\n", 1)
        if not header.startswith("对象："):
            raise AssertionError("Inference input lost its object context")
        return deepcopy(self.predictions[evidence_text])


class ReviewDocumentTests(unittest.TestCase):
    def run_review(self, text, matches_by_sentence, predictions=None,
                   relevance_by_evidence=None, source_id=None,
                   on_progress=None, on_start=None):
        verifier = FakeVerifier(predictions or {})
        connection = object()  # Cannot accidentally query a real database.
        progress = []
        starts = []

        def search(actual_connection, sentence, actual_source):
            self.assertIs(actual_connection, connection)
            matches = matches_by_sentence.get(sentence)
            if matches is None:
                return {"status": "not_found", "matches": []}
            return {"status": "found", "matches": deepcopy(matches)}

        def score(sentence, evidence_text):
            if relevance_by_evidence is None:
                return 4
            return relevance_by_evidence[evidence_text]

        with patch.object(serve, "search_evidence", side_effect=search) as lookup, \
                patch.object(serve, "relevance", side_effect=score):
            result = serve.review_document(
                text, source_id, verifier, connection,
                on_progress=on_progress or (lambda *args: progress.append(args)),
                on_start=on_start or starts.append,
            )
        return result, verifier, progress, starts, lookup

    def assert_consistent_contract(self, result, progress, starts):
        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(result["offset_basis"], "normalized_text_python_chars")
        self.assertIsInstance(result["normalized_text"], str)
        rows = result["results"]
        stats = result["stats"]
        statuses = {"supported", "refute", "insufficient",
                    "conflicting", "uncovered"}
        self.assertIsInstance(rows, list)
        self.assertIsInstance(result["problems"], list)
        self.assertEqual(starts, [len(rows)])
        self.assertEqual(len(progress), len(rows))
        self.assertEqual(stats["total_sentences"], len(rows))
        for index, row in enumerate(rows):
            self.assertEqual(row["index"], index)
            self.assertIn(row["status"], statuses)
            self.assertIsInstance(row["sentence"], str)
            self.assertIsInstance(row["reason"], str)
            self.assertIsInstance(row["message"], str)
            self.assertTrue(row["message"])
            self.assertIsInstance(row["evidence"], list)
            self.assertIs(type(row["sentence_start"]), int)
            self.assertIs(type(row["sentence_end"]), int)
            self.assertLess(row["sentence_start"], row["sentence_end"])
            self.assertEqual(
                result["normalized_text"][row["sentence_start"]:row["sentence_end"]],
                row["sentence"])
            self.assertEqual(progress[index],
                             (index, len(rows), row["sentence"], row["status"]))
        count_keys = {
            "supported": "supported_sentences",
            "refute": "refuted_sentences",
            "insufficient": "insufficient_sentences",
            "conflicting": "conflicting_sentences",
            "uncovered": "uncovered_sentences",
        }
        for status, key in count_keys.items():
            self.assertIs(type(stats[key]), int)
            self.assertEqual(stats[key], sum(row["status"] == status for row in rows))
        checked = sum(stats[key] for status, key in count_keys.items()
                      if status != "uncovered")
        self.assertEqual(stats["checked_sentences"], checked)
        self.assertEqual(stats["total_sentences"], checked + stats["uncovered_sentences"])
        self.assertEqual(stats["problems_found"], stats["refuted_sentences"])
        self.assertEqual(len(result["problems"]), stats["refuted_sentences"])
        self.assertEqual(stats["uncovered_sentences"],
                         stats["no_evidence_sentences"] + stats["low_relevance_sentences"])
        expected_coverage = checked / len(rows) if rows else None
        self.assertEqual(stats["coverage_ratio"], expected_coverage)

    def test_aggregation_preserves_uncertainty_and_evidence_conflicts(self):
        cases = [
            (("supports",), "supported"),
            (("refutes",), "refute"),
            (("insufficient",), "insufficient"),
            (("insufficient", "insufficient"), "insufficient"),
            (("supports", "insufficient"), "supported"),
            (("refutes", "insufficient"), "refute"),
            (("supports", "refutes"), "conflicting"),
            (("supports", "refutes", "insufficient"), "conflicting"),
        ]
        sentence = "这件棉袍采用对襟结构。"
        for labels, expected in cases:
            with self.subTest(labels=labels):
                matches = [evidence(i + 1) for i in range(len(labels))]
                predictions = {match["evidence_text"]: prediction(label)
                               for match, label in zip(matches, labels)}
                result, verifier, progress, starts, _ = self.run_review(
                    sentence, {sentence: matches}, predictions)
                self.assert_consistent_contract(result, progress, starts)
                row = result["results"][0]
                self.assertEqual(row["status"], expected)
                self.assertCountEqual([item["stance"] for item in row["evidence"]], labels)
                self.assertEqual(len(verifier.calls), len(labels))

    def test_every_candidate_keeps_prediction_and_traceable_source(self):
        sentence = "这件棉袍采用对襟结构。"
        matches = [evidence(1, source_id=7), evidence(2, source_id=9), evidence(3, source_id=11)]
        labels = ("supports", "refutes", "insufficient")
        predictions = {item["evidence_text"]: prediction(label)
                       for item, label in zip(matches, labels)}
        result, _, progress, starts, _ = self.run_review(
            sentence, {sentence: matches}, predictions)
        self.assert_consistent_contract(result, progress, starts)
        actual = {item["evidence_id"]: item for item in result["results"][0]["evidence"]}
        self.assertEqual(set(actual), {1, 2, 3})
        for item in matches:
            row = actual[item["id"]]
            for source_key, result_key in (("source_id", "source_id"),
                                           ("evidence_text", "evidence"),
                                           ("object_name", "object_name"),
                                           ("title", "source_title"),
                                           ("source_url", "source_url"),
                                           ("locator", "locator")):
                self.assertEqual(row[result_key], item[source_key])
            self.assertEqual(row["scores"], predictions[item["evidence_text"]]["scores"])
            self.assertEqual(row["relevance"], 4)

    def test_no_evidence_is_uncovered_and_never_calls_model(self):
        sentence = "这件棉袍的主人喜欢听音乐。"
        result, verifier, progress, starts, _ = self.run_review(sentence, {})
        self.assert_consistent_contract(result, progress, starts)
        self.assertEqual(result["results"][0]["status"], "uncovered")
        self.assertEqual(result["results"][0]["evidence"], [])
        self.assertEqual(result["stats"]["no_evidence_sentences"], 1)
        self.assertEqual(verifier.calls, [])

    def test_empty_found_matches_are_counted_as_no_evidence(self):
        sentence = "这件棉袍的主人喜欢听音乐。"
        result, verifier, progress, starts, _ = self.run_review(sentence, {sentence: []})
        self.assert_consistent_contract(result, progress, starts)
        self.assertEqual(result["results"][0]["status"], "uncovered")
        self.assertEqual(result["stats"]["no_evidence_sentences"], 1)
        self.assertEqual(verifier.calls, [])

    def test_low_relevance_is_uncovered_and_never_calls_model(self):
        sentence = "这件棉袍的主人喜欢听音乐。"
        match = evidence(1)
        result, verifier, progress, starts, _ = self.run_review(
            sentence, {sentence: [match]},
            relevance_by_evidence={match["evidence_text"]: serve.MIN_RELEVANCE - 1})
        self.assert_consistent_contract(result, progress, starts)
        self.assertEqual(result["results"][0]["status"], "uncovered")
        self.assertEqual(result["stats"]["low_relevance_sentences"], 1)
        self.assertEqual(result["stats"]["no_evidence_sentences"], 0)
        self.assertEqual(verifier.calls, [])

    def test_relative_relevance_filter_does_not_create_false_conflicts(self):
        sentence = "这件棉袍采用对襟结构。"
        matches = [evidence(1), evidence(2), evidence(3)]
        predictions = {matches[0]["evidence_text"]: prediction("supports"),
                       matches[1]["evidence_text"]: prediction("insufficient"),
                       matches[2]["evidence_text"]: prediction("refutes")}
        scores = {matches[0]["evidence_text"]: 8,
                  matches[1]["evidence_text"]: 4,
                  matches[2]["evidence_text"]: 3}
        result, verifier, progress, starts, _ = self.run_review(
            sentence, {sentence: matches}, predictions, scores)
        self.assert_consistent_contract(result, progress, starts)
        self.assertEqual(result["results"][0]["status"], "supported")
        self.assertEqual({item["evidence_id"] for item in result["results"][0]["evidence"]}, {1, 2})
        self.assertEqual(len(verifier.calls), 2)

    def test_real_relevance_rejects_unrelated_evidence_before_inference(self):
        sentence = "主人喜欢听音乐。"
        match = evidence(1, text="绿色棉布，对襟右衽。")
        verifier = FakeVerifier({})
        progress = []
        starts = []
        with patch.object(serve, "search_evidence",
                          return_value={"status": "found", "matches": [match]}):
            result = serve.review_document(
                sentence, None, verifier, object(),
                on_start=starts.append,
                on_progress=lambda *args: progress.append(args))
        self.assert_consistent_contract(result, progress, starts)
        self.assertEqual(result["results"][0]["status"], "uncovered")
        self.assertEqual(result["stats"]["low_relevance_sentences"], 1)
        self.assertEqual(verifier.calls, [])

    def test_mixed_document_keeps_all_sentences_and_correct_coverage(self):
        sentences = ["棉袍使用绿色棉布。", "花帽采用圆形帽顶。",
                     "长袍来自某位工匠。", "裙子采用刺绣花纹。",
                     "腰带的主人喜欢音乐。", "鞋子由朋友赠送。"]
        matches = [evidence(i) for i in range(1, 7)]
        found = {sentence: [match] for sentence, match in zip(sentences, matches)}
        found[sentences[3]].append(evidence(7))
        found.pop(sentences[4])
        labels = ("supports", "refutes", "insufficient",
                  "supports", "insufficient", "refutes")
        predictions = {item["evidence_text"]: prediction(label)
                       for item, label in zip(matches, labels)}
        predictions[evidence(7)["evidence_text"]] = prediction("refutes")
        scores = {item["evidence_text"]: 4 for items in found.values() for item in items}
        scores[matches[5]["evidence_text"]] = 0
        result, verifier, progress, starts, _ = self.run_review(
            "".join(sentences), found, predictions, scores)
        self.assert_consistent_contract(result, progress, starts)
        self.assertEqual([item["sentence"] for item in result["results"]], sentences)
        self.assertEqual([item["status"] for item in result["results"]],
                         ["supported", "refute", "insufficient",
                          "conflicting", "uncovered", "uncovered"])
        self.assertEqual(result["stats"]["coverage_ratio"], 4 / 6)
        self.assertEqual(len(verifier.calls), 5)

    def test_repeated_sentences_keep_distinct_offsets_after_cleaning(self):
        sentence = "这件棉袍采用对襟结构。"
        document = "　" + sentence + "\r\n\r\n" + sentence
        cleaned, _ = clean_text(document)
        match = evidence(1)
        result, _, progress, starts, _ = self.run_review(
            document, {sentence: [match]}, {match["evidence_text"]: prediction("supports")})
        self.assert_consistent_contract(result, progress, starts)
        rows = result["results"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(result["normalized_text"], cleaned)
        self.assertLess(rows[0]["sentence_end"], rows[1]["sentence_start"])
        for row in rows:
            self.assertEqual(cleaned[row["sentence_start"]:row["sentence_end"]], row["sentence"])
        self.assertEqual(rows[0]["sentence_start"], cleaned.index(sentence))
        self.assertEqual(rows[1]["sentence_start"], cleaned.rindex(sentence))

    def test_noise_is_excluded_from_body_and_coverage_denominator(self):
        sentence = "这件棉袍采用对襟结构。"
        document = "传统服饰说明文稿\n\n一、绿棉袍\n\n馆藏编号:123 民族:维吾尔族\n\n" + sentence
        match = evidence(1)
        result, verifier, progress, starts, lookup = self.run_review(
            document, {sentence: [match]}, {match["evidence_text"]: prediction("supports")})
        self.assert_consistent_contract(result, progress, starts)
        self.assertEqual(result["stats"]["noise_sentences"], 3)
        self.assertEqual(result["stats"]["total_sentences"], 1)
        self.assertEqual(result["stats"]["coverage_ratio"], 1)
        self.assertEqual(len(verifier.calls), 1)
        self.assertEqual(lookup.call_count, 1)

    def test_empty_or_noise_only_document_has_unknown_coverage(self):
        for text in ("", " \n\n", "传统服饰说明文稿"):
            with self.subTest(text=text):
                result, verifier, progress, starts, lookup = self.run_review(text, {})
                self.assert_consistent_contract(result, progress, starts)
                self.assertEqual(result["results"], [])
                self.assertIsNone(result["stats"]["coverage_ratio"])
                self.assertEqual(verifier.calls, [])
                lookup.assert_not_called()

    def test_source_fallback_only_runs_after_global_retrieval_misses(self):
        sentence = "这件棉袍采用对襟结构。"
        match = evidence(1)
        verifier = FakeVerifier({match["evidence_text"]: prediction("supports")})
        connection = object()
        with patch.object(serve, "search_evidence", side_effect=[
                {"status": "not_found", "matches": []},
                {"status": "found", "matches": [match]}]) as lookup, \
                patch.object(serve, "relevance", return_value=4):
            result = serve.review_document(sentence, 7, verifier, connection)
        self.assertEqual([call.args for call in lookup.call_args_list],
                         [(connection, sentence, None), (connection, sentence, 7)])
        self.assertEqual(result["results"][0]["status"], "supported")
        _, _, _, _, lookup = self.run_review(
            sentence, {sentence: [match]}, verifier.predictions, source_id=7)
        self.assertEqual(lookup.call_count, 1)

    def test_legacy_problems_choose_strongest_refutation_and_sort_by_confidence(self):
        first = "第一件棉袍采用套头结构。"
        second = "第二件棉袍使用皮革内里。"
        matches = [evidence(i) for i in range(1, 4)]
        predictions = {match["evidence_text"]: prediction("refutes", confidence)
                       for match, confidence in zip(matches, (0.75, 0.85, 0.95))}
        result, _, progress, starts, _ = self.run_review(
            first + second, {first: matches[:2], second: matches[2:]}, predictions)
        self.assert_consistent_contract(result, progress, starts)
        self.assertEqual([row["sentence"] for row in result["results"]], [first, second])
        self.assertEqual([row["evidence_id"] for row in result["problems"]], [3, 2])
        for problem in result["problems"]:
            self.assertEqual(problem["stance"], "refutes")
            self.assertIn("sentence_start", problem)
            self.assertIn("sentence_end", problem)

    def test_callback_failures_do_not_discard_results(self):
        sentence = "这件棉袍采用对襟结构。"
        match = evidence(1)

        def broken_callback(*args):
            raise RuntimeError("Disconnected progress consumer")

        result, verifier, _, _, _ = self.run_review(
            sentence, {sentence: [match]}, {match["evidence_text"]: prediction("insufficient")},
            on_start=broken_callback, on_progress=broken_callback)
        self.assertEqual(result["results"][0]["status"], "insufficient")
        self.assertEqual(result["stats"]["checked_sentences"], 1)
        self.assertEqual(len(verifier.calls), 1)

    def test_non_string_document_is_rejected_before_retrieval_or_inference(self):
        for value in (None, 123, False, [], {}):
            with self.subTest(value=value):
                verifier = FakeVerifier({})
                with patch.object(serve, "search_evidence") as lookup:
                    with self.assertRaises(ValueError):
                        serve.review_document(value, None, verifier, object())
                    lookup.assert_not_called()
                self.assertEqual(verifier.calls, [])

    def test_unknown_model_label_fails_without_reporting_a_successful_sentence(self):
        sentence = "这件棉袍采用对襟结构。"
        match = evidence(1)
        verifier = FakeVerifier({match["evidence_text"]: {"label": "unexpected", "scores": {}}})
        progress = []
        with patch.object(serve, "search_evidence",
                          return_value={"status": "found", "matches": [match]}), \
                patch.object(serve, "relevance", return_value=4):
            with self.assertRaises(RuntimeError):
                serve.review_document(
                    sentence, None, verifier, object(),
                    on_progress=lambda *args: progress.append(args))
        self.assertEqual(len(verifier.calls), 1)
        self.assertEqual(progress, [])

    def test_oversized_document_is_rejected_before_retrieval_or_inference(self):
        verifier = FakeVerifier({})
        progress = []
        with patch.object(serve, "search_evidence") as lookup:
            with self.assertRaises(ValueError):
                serve.review_document(
                    "衣" * 50001, None, verifier, object(),
                    on_progress=lambda *args: progress.append(args))
            lookup.assert_not_called()
        self.assertEqual(verifier.calls, [])
        self.assertEqual(progress, [])


if __name__ == "__main__":
    unittest.main()
