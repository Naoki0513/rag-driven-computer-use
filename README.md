# warp — Web Agent and Retrieval Pilot

warpは、検索による外部知識やコンテキスト圧縮を行うことで、通常よりも安く、速く、正確にブラウザタスクを実行してくれる、AIエージェントです。

### 従来手法と比較したメリット
| 指標 | 従来の方法 | warp |
| --- | --- | --- |
| 時間（1ステップあたり） | 10.56秒 | 4.73秒 |
| 価格（1ステップあたり）| $0.0264 | $0.0083 |
| 精度 | 測定中 | 測定中 |

### 従来手法との構造の違い
| 観点 | 従来手法 | warp |
| --- | --- | --- |
| 外部データベースの利用 | × 外部DBは基本利用せず、都度検索と画面入力に依存 | ◎ 事前クロールのインデックス（URL/テキスト）を活用 |
| スナップショット形式 | △ 画像＋テキスト（重くノイズ混入しやすい） | ◎ テキストのみ（軽量で抽出容易） |
| スナップショット範囲 | × 画面全体を毎回取得 | ◎ タスク関連部分のみを抽出（コンテキスト圧縮） |
| 対象範囲と精度 | ◎ Web全体を横断（精度はコンテキスト次第） | △ 対象サイト内は高精度／対象外は従来同等 |
| 事前準備 | ◎ ほぼ不要 | △ 対象サイトの事前クロールが必要 |

### なぜ Amazon Bedrock なのか
- Claude Sonnet 4 利用: Amazon Bedrock では、エージェント系ベンチマーク（例: tau-bench）で高性能な Claude Sonnet 4 を利用でき、速度・精度・コストのバランスがブラウザ操作AIエージェントに最適です（[Claude Sonnet 4](https://www.anthropic.com/news/claude-4?ref=faangboss.com)）。
- 高精度なリランキング: warp は検索結果の最適化が鍵であり、Amazon Bedrock の Rerank API から利用できる Cohere Rerank 3.5 は高い関連度判断性能を持ちます（[Cohere Rerank 3.5 on Amazon Bedrock](https://aws.amazon.com/jp/blogs/machine-learning/cohere-rerank-3-5-is-now-available-in-amazon-bedrock-through-rerank-api/)）。
- 一元プラットフォーム: 生成（Claude）と再ランキング（Cohere Rerank）を同一基盤で統合運用でき、開発・運用の複雑性とレイテンシを低減します。