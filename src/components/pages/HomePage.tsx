import React, { Fragment } from "react";

interface Feature {
  number: string;
  title: string[];
  description: string[];
  details: string[];
}

interface FeatureGroup {
  id: string;
  label: string;
  title: string[];
  description: string[];
  features: Feature[];
}

const featureGroups: FeatureGroup[] = [
  {
    id: "prepare",
    label: "BEFORE YOU GO",
    title: ["行く前に、", "ちゃんと", "調べる。"],
    description: [
      "カタログを",
      "眺める",
      "ところから、",
      "気になる",
      "サークルを",
      "調べて、",
      "当日の",
      "行き先を",
      "決める",
      "ところまで。",
      "予習の時間",
      "そのものを、",
      "もっと楽しく",
      "します。",
    ],
    features: [
      {
        number: "01",
        title: ["カタログを", "めくって、", "出会う。"],
        description: [
          "サークル",
          "カットを",
          "ギャラリーで",
          "一覧。",
          "知らなかった",
          "作品や",
          "作家にも、",
          "眺めながら",
          "自然に",
          "出会えます。",
        ],
        details: ["カット一覧", "ブロック別", "iPhone / iPad"],
      },
      {
        number: "02",
        title: ["気になる", "サークルを、", "深く知る。"],
        description: [
          "サークル名、",
          "作家名、",
          "紹介文、",
          "SNSまで",
          "ひと続きに",
          "確認。",
          "会場へ",
          "行く前に、",
          "頒布内容や",
          "活動を",
          "じっくり",
          "調べられます。",
        ],
        details: ["サークル詳細", "作家・紹介文", "SNS"],
      },
      {
        number: "03",
        title: ["覚えている", "言葉から、", "探し出す。"],
        description: [
          "サークル名が",
          "曖昧でも",
          "大丈夫。",
          "サークル、",
          "作家、",
          "紹介文を",
          "横断して",
          "検索し、",
          "候補を",
          "地図上で",
          "すぐ",
          "見つけます。",
        ],
        details: ["横断検索", "地図へハイライト", "件数表示"],
      },
      {
        number: "04",
        title: ["行きたい", "理由ごと、", "残しておく。"],
        description: [
          "気になる",
          "場所を",
          "色分けして、",
          "メモと",
          "一緒に保存。",
          "Circle.msの",
          "お気に入り",
          "とも",
          "同期し、",
          "調べた",
          "ことを",
          "当日まで",
          "つなぎます。",
        ],
        details: ["色分け", "メモ", "Circle.ms 同期"],
      },
    ],
  },
  {
    id: "navigate",
    label: "AT THE VENUE",
    title: ["会場で、", "迷わず", "まわる。"],
    description: [
      "調べておいた",
      "行き先を、",
      "そのまま",
      "会場図へ。",
      "広いホールでも",
      "現在見ている",
      "場所と",
      "次の目的地を、",
      "すばやく",
      "把握できます。",
    ],
    features: [
      {
        number: "05",
        title: ["会場全体を、", "自分の手で", "見渡す。"],
        description: [
          "開催回・",
          "日程・ホールを",
          "切り替え",
          "ながら、",
          "会場図を",
          "パン、ズーム、",
          "回転。",
          "テーブル",
          "単位まで",
          "滑らかに",
          "確認できます。",
        ],
        details: ["パン・ズーム・回転", "日程切り替え", "ホール切り替え"],
      },
      {
        number: "06",
        title: ["ジャンルの", "広がりを、", "地図に", "重ねる。"],
        description: [
          "ジャンル",
          "配置を",
          "会場図の上に",
          "表示。",
          "目的のエリア",
          "だけでなく、",
          "その周辺に",
          "ある",
          "新しい",
          "出会いも",
          "見つけやすく",
          "します。",
        ],
        details: ["ジャンルレイヤー", "配置の俯瞰", "表示切り替え"],
      },
      {
        number: "07",
        title: ["寄り道の", "少ない", "順番を、", "組み立てる。"],
        description: [
          "保存した",
          "サークルを",
          "地図上で",
          "結び、",
          "近い場所から",
          "巡る流れを",
          "自動で",
          "整理。",
          "予習した",
          "リストを、",
          "歩ける",
          "ルートに",
          "変えます。",
        ],
        details: ["ルート自動整理", "訪問順", "保存先を地図表示"],
      },
    ],
  },
];

function Phrase({ segments }: { segments: string[] }) {
  return segments.map((segment, index) => (
    <Fragment key={`${index}:${segment}`}>
      {index > 0 && <wbr />}
      {segment}
    </Fragment>
  ));
}

export default function HomePage() {
  return (
    <main className="home">
      <section className="hero" id="top" aria-labelledby="hero-title">
        <div className="convention-floor" aria-hidden="true">
          <canvas data-convention-floor />
        </div>

        <header className="hero__nav">
          <a className="wordmark" href="#top" aria-label="コミナビ ホーム">
            COMINAVI
          </a>
          <div className="hero__nav-links">
            <a href="#features">機能</a>
            <a href="https://github.com/cominavi" rel="noreferrer">
              GitHub
            </a>
          </div>
        </header>

        <div className="hero__content">
          <p className="hero__status">絶賛開発中</p>
          <h1 className="hero__title cjk-phrase" id="hero-title">
            <Phrase segments={["コミ", "ナビ"]} />
          </h1>
          <p className="hero__subtitle cjk-phrase">
            <Phrase segments={["コミケ非公式", "ナビゲーション", "アプリ"]} />
          </p>
          <p className="hero__statement cjk-phrase">
            <Phrase
              segments={[
                "調べる",
                "ところから、",
                "迷わず",
                "会える",
                "ところまで。",
              ]}
            />
          </p>
          <a className="hero__cta" href="#features">
            機能を見る
            <span aria-hidden="true">↓</span>
          </a>
        </div>

        <p className="hero__platform">FOR IPHONE + IPAD</p>
      </section>

      <section
        className="features"
        id="features"
        aria-labelledby="features-title"
      >
        <div className="features__inner">
          <header className="features__header">
            <p className="section-label">WHAT COMINAVI DOES / 07</p>
            <h2 className="cjk-phrase" id="features-title">
              <Phrase
                segments={[
                  "当日の",
                  "ための",
                  "予習も、",
                  "会場での",
                  "ナビも。",
                ]}
              />
            </h2>
            <p className="cjk-phrase">
              <Phrase
                segments={[
                  "コミナビは、",
                  "カタログを",
                  "「見る」だけで",
                  "終わらせ",
                  "ません。",
                  "見つけて、",
                  "調べて、",
                  "残して、",
                  "実際に",
                  "会いに行く",
                  "までを",
                  "一つに",
                  "つなげます。",
                ]}
              />
            </p>
          </header>

          <div className="feature-journey">
            {featureGroups.map((group, groupIndex) => (
              <section
                className={`feature-phase feature-phase--${group.id}`}
                aria-labelledby={`phase-${group.id}`}
                key={group.id}
              >
                <header className="feature-phase__header">
                  <div className="feature-phase__index" aria-hidden="true">
                    {String(groupIndex + 1).padStart(2, "0")}
                  </div>
                  <div>
                    <p>{group.label}</p>
                    <h3 className="cjk-phrase" id={`phase-${group.id}`}>
                      <Phrase segments={group.title} />
                    </h3>
                    <span className="cjk-phrase">
                      <Phrase segments={group.description} />
                    </span>
                  </div>
                </header>

                <ol className="feature-list">
                  {group.features.map((feature) => (
                    <li className="feature-item" key={feature.number}>
                      <div className="feature-item__number" aria-hidden="true">
                        {feature.number}
                      </div>
                      <div className="feature-item__copy">
                        <h4 className="cjk-phrase">
                          <Phrase segments={feature.title} />
                        </h4>
                        <p className="cjk-phrase">
                          <Phrase segments={feature.description} />
                        </p>
                        <ul aria-label={`${feature.title.join("")}の要点`}>
                          {feature.details.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>

          <footer className="features__footer">
            <div>
              <p className="section-label">STILL IN DEVELOPMENT</p>
              <p className="cjk-phrase">
                <Phrase
                  segments={[
                    "掲載している",
                    "機能や画面は、",
                    "現在開発中です。",
                  ]}
                />
              </p>
            </div>
            <div className="features__footer-links">
              <a href="/privacy">プライバシー / Privacy</a>
              <a href="https://github.com/cominavi" rel="noreferrer">
                GitHub で開発を見る
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          </footer>
        </div>
      </section>
    </main>
  );
}
