import React from "react";

type IconName =
  | "arrow-right"
  | "bookmark"
  | "compass"
  | "list-checks"
  | "navigation"
  | "route"
  | "search"
  | "sparkles"
  | "users";

type Feature = {
  description: string;
  details: string[];
  icon: IconName;
  number: string;
  title: string[];
};

const phases: Array<{
  description: string;
  features: Feature[];
  number: string;
  title: string;
}> = [
  {
    number: "01",
    title: "行く前に、ちゃんと調べる。",
    description:
      "まだ知らないサークルに出会い、気になる場所を自分の言葉で残す。カタログを見る時間を、当日のための確かな準備に変えます。",
    features: [
      {
        number: "01",
        icon: "search",
        title: ["カタログをめくって、", "出会う。"],
        description:
          "サークルカットをギャラリーで一覧。ブロックごとの空気を眺めながら、知らなかった作品と自然に出会えます。",
        details: ["カット一覧", "ブロック別", "iPhone / iPad"],
      },
      {
        number: "02",
        icon: "sparkles",
        title: ["気になるサークルを、", "深く知る。"],
        description:
          "作家や紹介文、SNSへの入口をひとつの詳細画面に。気になった理由を見失わず、次の発見へ進めます。",
        details: ["サークル詳細", "作家・紹介文", "SNS"],
      },
      {
        number: "03",
        icon: "search",
        title: ["覚えている言葉から、", "探し出す。"],
        description:
          "サークル名、作家名、紹介文をまとめて検索。見つけた結果を会場マップへつなぎ、場所まで確かめられます。",
        details: ["横断検索", "地図へハイライト", "件数表示"],
      },
      {
        number: "04",
        icon: "bookmark",
        title: ["行きたい理由ごと、", "残しておく。"],
        description:
          "気になるサークルを色分けし、短いメモと一緒に保存。Circle.msとの同期も、必要な人だけ選べます。",
        details: ["色分け", "メモ", "Circle.ms 同期"],
      },
    ],
  },
  {
    number: "02",
    title: "会場で、迷わずまわる。",
    description:
      "広い会場でも、見たい情報だけを手元に。保存したサークルと現在地を結び、次に向かう場所をすぐ判断できます。",
    features: [
      {
        number: "05",
        icon: "compass",
        title: ["会場全体を、", "自分の手で見渡す。"],
        description:
          "パン、ズーム、回転に対応した会場マップ。参加日やホールを切り替えながら、自分の感覚で全体を把握できます。",
        details: ["パン・ズーム・回転", "日程切り替え", "ホール切り替え"],
      },
      {
        number: "06",
        icon: "sparkles",
        title: ["ジャンルの広がりを、", "地図に重ねる。"],
        description:
          "ジャンルごとの配置を地図の上に表示。会場に生まれるまとまりや、思いがけない寄り道を俯瞰できます。",
        details: ["ジャンルレイヤー", "配置の俯瞰", "表示切り替え"],
      },
      {
        number: "07",
        icon: "navigation",
        title: ["寄り道の少ない順番を、", "組み立てる。"],
        description:
          "保存したサークルを訪問しやすい順に整理。次の行き先を地図で確かめながら、一日の流れを組み立てられます。",
        details: ["ルート自動整理", "訪問順", "保存先を地図表示"],
      },
    ],
  },
];

function Icon({ name }: { name: IconName }) {
  return (
    <svg aria-hidden="true">
      <use href={`#icon-${name}`} />
    </svg>
  );
}

function Phrase({ children }: { children: string[] }) {
  return (
    <span className="cjk-phrase">
      {children.map((part, index) => (
        <React.Fragment key={part}>
          {index > 0 ? <wbr /> : null}
          {part}
        </React.Fragment>
      ))}
    </span>
  );
}

export default function HomePage() {
  return (
    <main className="home">
      <section className="home-hero" id="top">
        <header className="home-nav">
          <a className="home-wordmark" href="#top" aria-label="コミナビ ホーム">
            <Icon name="compass" />
            <span>COMINAVI</span>
          </a>
          <nav aria-label="ページ内ナビゲーション">
            <a href="#features">できること</a>
            <a href="#shared-plans">Shared Plans</a>
            <a href="/privacy">Privacy</a>
          </nav>
        </header>

        <div className="home-hero__stage">
          <div className="home-hero__copy">
            <h1>
              <span className="cjk-phrase">
                調べるところから、
                <wbr />
                迷わず会える
                <br className="home-mobile-break" />
                ところまで。
              </span>
            </h1>
            <p className="home-hero__subtitle">
              <Phrase children={["コミケ非公式", "ナビゲーション", "アプリ"]} />
            </p>
            <p className="home-hero__lead">
              見つける。残す。いっしょに計画する。そして、会場でたどり着く。
              コミナビは、コミケの準備から当日までをひとつの道筋につなぎます。
            </p>
            <div className="home-hero__actions">
              <a className="home-primary-action" href="#features">
                <span>できることを見る</span>
                <Icon name="arrow-right" />
              </a>
              <p>開発中 · iPhone + iPad</p>
            </div>
          </div>

          <div className="home-route" aria-label="コミナビでつながる三つの場面">
            <Icon name="route" />
            <svg
              className="home-route__line"
              viewBox="0 0 560 700"
              aria-hidden="true"
            >
              <path d="M472 34v118c0 68-46 105-113 105H202c-68 0-114 37-114 105v84c0 68 46 105 114 105h100c68 0 114 37 114 105v20" />
              <circle cx="472" cy="34" r="13" />
              <circle cx="88" cy="404" r="13" />
              <circle cx="416" cy="676" r="13" />
            </svg>
            <ol>
              <li>
                <span>01</span>
                <Icon name="search" />
                <div>
                  <strong>探す・見つける</strong>
                  <p>カタログと検索から、まだ知らない作品へ。</p>
                </div>
              </li>
              <li>
                <span>02</span>
                <Icon name="users" />
                <div>
                  <strong>いっしょに計画する</strong>
                  <p>行きたい場所と購入予定を、みんなのプランへ。</p>
                </div>
              </li>
              <li>
                <span>03</span>
                <Icon name="navigation" />
                <div>
                  <strong>会場でたどり着く</strong>
                  <p>保存した場所とルートを、迷わない一日のために。</p>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section className="home-thought" aria-label="コミナビの思い">
        <Icon name="sparkles" />
        <p>
          好きなものに会える一日は、
          <br />
          準備の時間から始まっている。
        </p>
      </section>

      <section className="home-features" id="features">
        <header className="home-features__intro">
          <h2>一日の流れに、必要な道具を。</h2>
          <p>
            機能を増やすためではなく、次に何をすればいいかが自然に見えるために。
            調べる時間と歩く時間を、同じ感覚でつなぎます。
          </p>
        </header>

        {phases.map((phase) => (
          <section className="home-phase" key={phase.number}>
            <header className="home-phase__header">
              <span>{phase.number}</span>
              <h3>{phase.title}</h3>
              <p>{phase.description}</p>
            </header>
            <ol className="home-feature-list">
              {phase.features.map((feature) => (
                <li className="feature-item" key={feature.number}>
                  <div className="feature-item__marker">
                    <span>{feature.number}</span>
                    <Icon name={feature.icon} />
                  </div>
                  <div className="feature-item__body">
                    <h4>
                      <Phrase children={feature.title} />
                    </h4>
                    <p>{feature.description}</p>
                    <ul aria-label="機能の要点">
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
      </section>

      <section className="home-shared" id="shared-plans">
        <svg
          className="home-shared__route"
          viewBox="0 0 1120 360"
          aria-hidden="true"
        >
          <path d="M0 174h245c74 0 112-38 112-112v-18M357 44v202c0 74 38 112 112 112h252c74 0 112-38 112-112v-68c0-74 38-112 112-112h175" />
          <circle cx="357" cy="44" r="12" />
          <circle cx="833" cy="178" r="12" />
        </svg>
        <Icon name="users" />
        <div className="home-shared__content">
          <h2>ひとりの予定を、みんなのプランへ。</h2>
          <p>
            Shared Plans では、行きたいサークル、メモ、購入予定を仲間と共有。
            招待リンクから参加して、それぞれの「欲しい」と「買いに行ける」を一つの計画にまとめられます。
          </p>
          <ul>
            <li>
              <Icon name="bookmark" />
              <span>サークルとメモを共有</span>
            </li>
            <li>
              <Icon name="list-checks" />
              <span>購入予定と担当を整理</span>
            </li>
            <li>
              <Icon name="users" />
              <span>招待した仲間と更新</span>
            </li>
          </ul>
        </div>
      </section>

      <footer className="home-footer">
        <div>
          <a className="home-wordmark" href="#top">
            <Icon name="compass" />
            <span>COMINAVI</span>
          </a>
          <p>
            コミケの準備から当日まで。好きなものへ、迷わず会いに行くために。
          </p>
        </div>
        <nav aria-label="フッターナビゲーション">
          <a href="/privacy">プライバシー / Privacy</a>
          <a href="https://github.com/ProjectAnni/cominavi">GitHub</a>
        </nav>
        <p>現在開発中です。掲載内容は予告なく変わる場合があります。</p>
      </footer>
    </main>
  );
}
