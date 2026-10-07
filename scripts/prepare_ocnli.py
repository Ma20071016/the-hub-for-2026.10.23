import json
import hashlib
import subprocess
import unicodedata
from collections import Counter
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
RAW_REPO = PROJECT_DIR / "data/raw/ocnli"
DATA_DIR = RAW_REPO / "data/ocnli"
OUTPUT_DIR = PROJECT_DIR / "data/processed/ocnli"
REPORT_PATH = PROJECT_DIR / "reports/ocnli_preprocessing.json"
SOURCE_URL = "https://github.com/CLUEbenchmark/OCNLI"

LABEL_MAP = {
    "entailment": "supports",
    "contradiction": "refutes",
    "neutral": "insufficient",
}
LABEL_TO_ID = {"supports": 0, "refutes": 1, "insufficient": 2}
OUTPUT_FIELDS = {
    "id", "claim", "evidence", "label", "source_id", "source_locator", "group_id"
}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_valid_rows(path):
    """读取原文，记录每条样本的原始行号和排除原因。"""
    rows = []
    excluded = []
    seen_ids = set()
    raw_count = 0

    with path.open(encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            if not line.strip():
                continue

            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"{path} 第 {line_number} 行不是 JSON 对象")
            raw_count += 1
            label = row.get("label")
            raw_id = row.get("id")
            if type(raw_id) not in (str, int) or not str(raw_id).strip():
                raise ValueError(f"{path} 第 {line_number} 行缺少有效 id")
            if str(raw_id) in seen_ids:
                raise ValueError(f"{path} 文件内 id 重复：{raw_id}")
            seen_ids.add(str(raw_id))

            if label == "-":
                excluded.append({"id": raw_id, "line": line_number, "reason": "no_consensus"})
                continue

            if label not in LABEL_MAP:
                raise ValueError(
                    f"{path} 第 {line_number} 行存在未知标签：{label}"
                )

            if any(not isinstance(row.get(key), str) or not row[key].strip()
                   for key in ("sentence1", "sentence2")):
                excluded.append({"id": raw_id, "line": line_number, "reason": "missing_or_empty_text"})
                continue
            if row.get("prem_id") is not None and (
                not isinstance(row["prem_id"], str) or not row["prem_id"].strip()
            ):
                raise ValueError(f"{path} 第 {line_number} 行 prem_id 格式无效")

            row["_source_file"] = path.relative_to(RAW_REPO).as_posix()
            row["_line"] = line_number
            rows.append(row)

    return rows, {
        "file": path.relative_to(RAW_REPO).as_posix(),
        "sha256": sha256(path),
        "raw_count": raw_count,
        "valid_count": len(rows),
        "excluded_count": len(excluded),
        "excluded": excluded,
    }


def evidence_key(row):
    """规范化仅用于查重；输出中的证据原文不做改写。"""
    return "".join(unicodedata.normalize("NFKC", row["sentence1"]).split())


def assign_group_ids(rows):
    """用并查集合并同 prem_id 或同证据的样本，处理间接关联。"""
    parents = list(range(len(rows)))
    owners = {}

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for index, row in enumerate(rows):
        text_hash = hashlib.sha256(evidence_key(row).encode("utf-8")).hexdigest()
        keys = [f"text:{text_hash}"]
        if row.get("prem_id"):
            keys.append(f"prem:{row['prem_id']}")
        for key in keys:
            if key in owners:
                parents[find(index)] = find(owners[key])
            else:
                owners[key] = index

    # 同一连通组选择固定锚点，使编号不受输入行排列顺序影响。
    anchors = {}
    for key, index in owners.items():
        root = find(index)
        anchors[root] = min(key, anchors.get(root, key))
    for index, row in enumerate(rows):
        row["_group_id"] = f"ocnli:group:{anchors[find(index)]}"


def isolate_train(train, dev):
    assign_group_ids(train + dev)
    dev_groups = {row["_group_id"] for row in dev}
    kept, removed = [], []
    for row in train:
        (removed if row["_group_id"] in dev_groups else kept).append(row)
    return kept, removed


def convert_row(row, revision):
    source_file = row["_source_file"]
    # train/dev 的原始 id 可能相同，所以输出 id 加入文件标识。
    sample_id = f"ocnli:{Path(source_file).stem}:{row['id']}"
    source = row.get("prem_id")
    source_id = f"ocnli:prem:{source}" if source else (
        "ocnli:text:" + hashlib.sha256(evidence_key(row).encode("utf-8")).hexdigest()
    )
    return {
        "id": sample_id,
        "claim": row["sentence2"],
        "evidence": row["sentence1"],
        "label": LABEL_MAP[row["label"]],
        "source_id": source_id,
        "source_locator": f"{SOURCE_URL}/blob/{revision}/{source_file}#L{row['_line']}",
        "group_id": row["_group_id"],
    }


def validate_outputs(train, dev):
    all_rows = train + dev
    for row in all_rows:
        if set(row) != OUTPUT_FIELDS:
            raise ValueError("输出字段不符合七字段数据规范")
        if any(not isinstance(value, str) or not value.strip() for value in row.values()):
            raise ValueError(f"输出样本存在空字段：{row.get('id')}")
        if row["label"] not in LABEL_TO_ID:
            raise ValueError(f"输出标签无效：{row['label']}")
    if len({row["id"] for row in all_rows}) != len(all_rows):
        raise ValueError("输出样本 id 不唯一")
    for key in ("id", "source_id", "group_id"):
        if {row[key] for row in train} & {row[key] for row in dev}:
            raise ValueError(f"训练和验证之间仍有重合：{key}")
    train_texts = {evidence_key({"sentence1": row["evidence"]}) for row in train}
    dev_texts = {evidence_key({"sentence1": row["evidence"]}) for row in dev}
    if train_texts & dev_texts:
        raise ValueError("训练和验证之间仍有相同证据")
    if not train or not dev:
        raise ValueError("处理后的训练集和验证集都必须非空")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write("\n")


def write_jsonl(path, rows):
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def main():
    # 来源定位固定到原仓库提交；有本地原始数据改动时先停止，避免错误追溯。
    revision = subprocess.check_output(
        ["git", "-C", str(RAW_REPO), "rev-parse", "HEAD"], text=True
    ).strip()
    subprocess.run(
        ["git", "-C", str(RAW_REPO), "diff", "--exit-code", "HEAD", "--",
         "data/ocnli/train.3k.json", "data/ocnli/dev.json"], check=True
    )
    train, train_stats = load_valid_rows(DATA_DIR / "train.3k.json")
    dev, dev_stats = load_valid_rows(DATA_DIR / "dev.json")
    shared_raw_ids = len({r["id"] for r in train} & {r["id"] for r in dev})
    clean_train, removed = isolate_train(train, dev)
    converted_train = [convert_row(row, revision) for row in clean_train]
    converted_dev = [convert_row(row, revision) for row in dev]
    validate_outputs(converted_train, converted_dev)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = {}
    for name, rows in (("train", converted_train), ("validation", converted_dev)):
        path = OUTPUT_DIR / f"{name}.jsonl"
        write_jsonl(path, rows)
        outputs[name] = {
            "path": path.relative_to(PROJECT_DIR).as_posix(),
            "count": len(rows),
            "groups": len({row["group_id"] for row in rows}),
            "label_counts": {label: Counter(row["label"] for row in rows)[label] for label in LABEL_TO_ID},
            "sha256": sha256(path),
        }

    report = {
        "format_version": 1,
        "source": {
            "repository": SOURCE_URL, "revision": revision,
            "paper": "https://arxiv.org/abs/2010.05444",
            "license": "CC BY-NC 2.0",
            "license_url": "https://creativecommons.org/licenses/by-nc/2.0/",
            "locator_scope": "Official dataset row, not an original historical source citation",
        },
        "inputs": {"train": train_stats, "validation": dev_stats},
        "label_map": LABEL_MAP,
        "label_to_id_for_future_training": LABEL_TO_ID,
        "grouping": "Connected components of shared nonempty prem_id OR NFKC/whitespace-normalized premise; retain official dev and exclude connected train groups",
        "raw_id_overlap_before_namespacing": shared_raw_ids,
        "excluded_train_overlap": [
            {"id": r["id"], "prem_id": r.get("prem_id"), "group_id": r["_group_id"],
             "file": r["_source_file"], "line": r["_line"], "reason": "group_shared_with_validation"}
            for r in removed
        ],
        "outputs": outputs,
        "validation": {"unique_ids": True, "seven_field_schema": True,
                       "cross_split_group_overlap": 0, "cross_split_evidence_overlap": 0},
        "script_sha256": sha256(Path(__file__)),
        "scope": "OCNLI train.3k development data; test.json unused; not costume-domain validation or an official test score",
    }
    write_json(REPORT_PATH, report)
    print(f"训练原始 {train_stats['raw_count']} 条，过滤无效 {train_stats['excluded_count']} 条，排除重合 {len(removed)} 条")
    for name, info in outputs.items():
        print(f"{name}: {info['count']} 条，标签分布 {info['label_counts']}")
        print(f"  保存至 {info['path']}")
    print("检查通过：字段完整，样本 ID 唯一，训练/验证的分组与证据均不重合。")
    print(f"处理报告：{REPORT_PATH.relative_to(PROJECT_DIR).as_posix()}")


if __name__ == "__main__":
    main()
