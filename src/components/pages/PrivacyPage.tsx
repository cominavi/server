import React from "react";

const updatedAt = "2026-08-09";

export default function PrivacyPage() {
  return (
    <main className="privacy">
      <header className="privacy__nav">
        <a className="wordmark" href="/">
          COMINAVI
        </a>
        <a href="#english">English</a>
      </header>

      <article className="privacy__document">
        <header className="privacy__hero">
          <p className="privacy__eyebrow">PRIVACY / プライバシー</p>
          <h1>
            <span className="cjk-phrase">
              プライバシー
              <wbr />
              ポリシー
            </span>
          </h1>
          <p>
            コミナビを安心して使っていただくため、取り扱う情報とその目的を説明します。
          </p>
          <dl>
            <div>
              <dt>運営者</dt>
              <dd>MikuNet LLC</dd>
            </div>
            <div>
              <dt>最終更新</dt>
              <dd>
                <time dateTime={updatedAt}>2026年8月9日</time>
              </dd>
            </div>
          </dl>
        </header>

        <div className="privacy__sections" lang="ja">
          <section>
            <p className="privacy__number">01</p>
            <div>
              <h2>取り扱う情報</h2>
              <p>
                Circle.msでログインすると、ユーザーID、表示名、R18表示設定、OAuthのアクセストークンおよびリフレッシュトークンを取り扱います。トークンは端末のKeychainに保存します。
              </p>
              <p>
                カタログ、画像、保存したサークル、メモ、表示設定などは、原則として端末内に保存します。Circle.msとの同期機能を使う場合は、対象の情報をCircle.msへ送受信します。
              </p>
              <p>
                お気に入りの更新通知またはXフォロー情報の取り込みを使う場合は、対象のサークル情報およびXアカウント情報を、ログイン中のユーザーIDと関連付けてcominavi.netで処理・保存します。
              </p>
            </div>
          </section>

          <section>
            <p className="privacy__number">02</p>
            <div>
              <h2>位置情報と方位</h2>
              <p>
                位置情報は任意です。「現在地を設定」を開いている間、近くの会場候補と向きを表示するために使います。コミナビは位置情報と方位を端末内で処理し、保存または運営者のサーバーへ送信しません。許可しなくても会場を手動で選べます。
              </p>
            </div>
          </section>

          <section>
            <p className="privacy__number">03</p>
            <div>
              <h2>品質改善と診断</h2>
              <p>
                不具合の調査、性能改善、機能の利用状況の把握にSentryとPostHogを使用します。これらのサービスには、アプリや端末の情報、操作イベント、クラッシュおよび性能情報が送信される場合があります。
              </p>
              <p>
                ログイン後は、Circle.msのユーザーID、表示名、R18表示設定を診断・分析情報に関連付ける場合があります。広告配信のための追跡は行わず、個人情報を販売しません。
              </p>
            </div>
          </section>

          <section>
            <p className="privacy__number">04</p>
            <div>
              <h2>外部サービスと通信</h2>
              <p>
                認証とカタログ取得にはCircle.ms、ユーザー認証・通知・取り込み機能にはcominavi.net、診断と分析にはSentryとPostHog、地図表示にはOpenStreetMap、OpenMapTiles、Americana
                Mapなどの提供元を利用します。Xの公開情報の取得にはTwitterAPI.io、更新通知の配信にはApple
                Push Notification
                serviceを利用します。通信時には、各提供元がIPアドレスや一般的なリクエスト情報を受け取る場合があります。
              </p>
            </div>
          </section>

          <section>
            <p className="privacy__number">05</p>
            <div>
              <h2>保存、削除、問い合わせ</h2>
              <p>
                ログアウトすると端末内のCircle.msセッションを削除します。アプリを削除すると、端末内のカタログ、キャッシュ、設定、保存内容も削除されます。外部サービス上の診断・分析情報は各サービスの方針に従って保持されます。
              </p>
              <p>
                cominavi.netに保存されたお気に入り、通知端末、取り込み結果などの削除を希望する場合は、下記の連絡先から請求できます。
              </p>
              <p>
                本ポリシーやデータの取り扱いに関するお問い合わせは、
                <a href="mailto:hello@mikunet.llc">hello@mikunet.llc</a>
                までご連絡ください。
              </p>
            </div>
          </section>
        </div>

        <div className="privacy__english" id="english" lang="en">
          <header>
            <p className="privacy__eyebrow">ENGLISH</p>
            <h2>Privacy Policy</h2>
            <p>Last updated August 9, 2026 · Operator: MikuNet LLC</p>
          </header>

          <section>
            <h3>Information we process</h3>
            <p>
              When you sign in with Circle.ms, ComiNavi processes your Circle.ms
              user ID, display name, R18 display preference, OAuth access token,
              and refresh token. Tokens are stored in the device Keychain.
              Catalogs, images, saved circles, notes, and settings are generally
              stored on your device. Information selected for Circle.ms
              synchronization is exchanged with Circle.ms.
            </p>
            <p>
              If you use favorite-update notifications or X following import,
              the relevant circle and X account information is processed and
              stored by cominavi.net in association with your signed-in user ID.
            </p>
          </section>

          <section>
            <h3>Location and heading</h3>
            <p>
              Location access is optional and is used while Where Am I is open
              to suggest nearby venue areas and show your heading. ComiNavi
              processes location and heading on device and does not retain them
              or send them to the operator’s servers. You can always choose a
              venue manually.
            </p>
          </section>

          <section>
            <h3>Diagnostics and analytics</h3>
            <p>
              ComiNavi uses Sentry and PostHog to investigate errors, improve
              performance, and understand feature usage. App and device
              information, usage events, crash data, and performance data may be
              sent to these services. After sign-in, your Circle.ms user ID,
              display name, and R18 display preference may be associated with
              diagnostic and analytics data. We do not use this data for
              advertising tracking and do not sell personal information.
            </p>
          </section>

          <section>
            <h3>Service providers, retention, and deletion</h3>
            <p>
              ComiNavi uses Circle.ms for authentication and catalogs,
              cominavi.net for user authentication, notifications, and imports,
              Sentry and PostHog for diagnostics and analytics, and providers
              including OpenStreetMap, OpenMapTiles, and Americana Map for map
              content. TwitterAPI.io retrieves public X post information, and
              Apple Push Notification service delivers circle-update
              notifications. These providers may receive IP addresses and
              standard request information.
            </p>
            <p>
              Signing out removes the Circle.ms session stored by ComiNavi.
              Deleting the app removes its local catalogs, caches, settings, and
              saved content. Diagnostic and analytics records are retained under
              each provider’s policy.
            </p>
            <p>
              You may contact us below to request deletion of favorites, push
              devices, import results, and other records stored by cominavi.net.
            </p>
          </section>

          <section>
            <h3>Contact</h3>
            <p>
              Questions or data requests can be sent to{" "}
              <a href="mailto:hello@mikunet.llc">hello@mikunet.llc</a>.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
