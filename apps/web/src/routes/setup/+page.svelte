<!--
  최초 설치 (계획서 4.7 1·2·4번). 서버 콘솔의 일회용 설치 토큰으로 첫 관리자와 공개 주소를 정한다.
  OmniRoute 연결(3번)은 S5, 메일 설정(5번) 화면은 이후 단계에서 붙인다.
-->
<script lang="ts">
  import { fetchSetupStatus, submitSetup, type SetupForm } from "./api";

  const status = fetchSetupStatus();
  let form = $state<SetupForm>({ token: "", email: "", password: "", name: "", publicBaseUrl: "" });
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let done = $state(false);

  async function onsubmit(event: SubmitEvent) {
    event.preventDefault();
    submitting = true;
    error = null;
    const result = await submitSetup(form);
    submitting = false;
    if (result.ok) done = true;
    else error = result.reason;
  }
</script>

<main>
  <h1>최초 설치</h1>
  {#await status}
    <p>설치 상태를 확인하는 중입니다.</p>
  {:then current}
    {#if !current.ok}
      <p role="alert">{current.reason}</p>
    {:else if done || !current.needed}
      <p>설치가 끝났습니다. <a href="/">로그인 화면으로</a></p>
    {:else}
      <form {onsubmit}>
        <label>설치 토큰 <input name="token" bind:value={form.token} required autocomplete="off" /></label>
        <label>관리자 이메일 <input name="email" type="email" bind:value={form.email} required /></label>
        <label>비밀번호 <input name="password" type="password" bind:value={form.password} required minlength="8" maxlength="128" /></label>
        <label>이름 <input name="name" bind:value={form.name} /></label>
        <label>
          공개 주소 (회원이 도구에 넣을 주소)
          <input name="publicBaseUrl" type="url" bind:value={form.publicBaseUrl} required placeholder="https://llm.example.com" />
        </label>
        {#if error}<p role="alert">{error}</p>{/if}
        <button type="submit" disabled={submitting}>관리자 만들기</button>
      </form>
    {/if}
  {/await}
</main>

<style>
  form {
    display: grid;
    gap: 0.75rem;
    max-width: 28rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
</style>
