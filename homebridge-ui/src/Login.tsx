import { useEffect, useRef, useState } from 'react';
import { Box, Callout, Card, Flex, Heading, Separator, Text, TextField } from '@radix-ui/themes';
import { CheckIcon, EnvelopeClosedIcon, LockClosedIcon } from '@radix-ui/react-icons';
import { Badge, Button } from './core/radix.js';
import { isEmailIdentifier, StaleAccountError, useApp } from './core/index.js';

export default function Login() {
  const app = useApp();
  const [identifier, setIdentifier] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const sequence = useRef(0);
  const codeRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    sequence.current++;
    setAuthCode(''); setPassword(''); setSent(false); setVerified(false); setMessage(''); setBusy(false);
  }, [app.accountEpoch]);
  useEffect(() => () => {
    sequence.current++;
  }, []);
  const changeIdentifier = (value: string) => {
    sequence.current++; setIdentifier(value); setAuthCode(''); setPassword(''); setSent(false); setVerified(false); setMessage(''); setBusy(false);
  };
  const email = () => {
    if (isEmailIdentifier(identifier)) {
      return identifier.trim();
    }
    const error = app.t('이메일 로그인만 지원합니다. 헤이홈 앱에 등록한 이메일을 입력해 주세요.',
      'Only email sign-in is supported. Enter the email registered in the Hejhome app.');
    setMessage(error); app.notify('error', error); return null;
  };
  const run = async (action: (token: number) => Promise<void>) => {
    if (busy) {
      return;
    }
    const token = ++sequence.current;
    setBusy(true); setMessage('');
    try {
      await action(token);
    } catch (error) {
      if (token !== sequence.current || error instanceof StaleAccountError) {
        return;
      }
      const text = app.language === 'en' ? 'Could not complete this step. Please check your connection and try again.'
        : error instanceof Error ? error.message : String(error);
      setMessage(text); app.notify('error', text);
    } finally {
      if (token === sequence.current) {
        setBusy(false);
      }
    }
  };
  const send = () => {
    const address = email(); if (!address) {
      return;
    }
    void run(async (token) => {
      setSent(false); setVerified(false); setAuthCode(''); setPassword('');
      await app.request('/send-verification', { identifier: address }, { timeoutMs: 15000 });
      if (token !== sequence.current) {
        return;
      }
      setSent(true); app.notify('success', app.t('인증번호를 전송했습니다.', 'Code sent.'));
    });
  };
  const verify = () => {
    const address = email(); if (!address || !sent || !/^\d{6}$/.test(authCode.trim())) {
      return;
    }
    void run(async (token) => {
      await app.request('/verify-code', { identifier: address, authCode: authCode.trim() }, { timeoutMs: 15000 });
      if (token !== sequence.current) {
        return;
      }
      setVerified(true); app.notify('success', app.t('인증번호가 확인되었습니다.', 'Code verified.'));
    });
  };
  const login = () => {
    const address = email(); if (!address || !verified || !password) {
      return;
    }
    void run(async (token) => {
      await app.login(address, password);
      if (token !== sequence.current) {
        return;
      }
      setPassword('');
      setMessage(app.t('로그인이 저장되었습니다. Homebridge가 Apple Home 연결을 준비합니다.',
        'Sign-in saved. Homebridge is preparing the Apple Home connection.'));
    });
  };
  useEffect(() => {
    if (sent && !busy && !verified) {
      codeRef.current?.focus();
    }
  }, [sent, busy, verified]);
  useEffect(() => {
    if (verified && !busy) {
      passwordRef.current?.focus();
    }
  }, [verified, busy]);
  const steps = [app.t('이메일', 'Email'), app.t('인증번호', 'Verification'), app.t('비밀번호', 'Password')];
  const step = verified ? 2 : sent ? 1 : 0;
  return <Box id="loginView" className="login-page">
    <Card className="login-card" size="4">
      <Flex direction="column" gap="5">
        <Flex direction="column" gap="2">
          <Badge highContrast color="jade" variant="soft" style={{ alignSelf: 'flex-start' }}>HOME CONNECTION</Badge>
          <Heading as="h1" size="7">Hejhome</Heading>
          <Text color="gray">{app.t('헤이홈 계정을 연결하고, 나에게 맞는 스마트 홈을 구성하세요.',
            'Connect your Hejhome account and make your smart home your own.')}</Text>
        </Flex>
        <Flex asChild gap="3" wrap="wrap" className="login-steps"><ol aria-label={app.t('로그인 단계', 'Sign-in steps')}>
          {steps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}>
            <Badge highContrast color={step >= index ? 'jade' : 'gray'} variant={step === index ? 'solid' : 'soft'}>
              {index < step ? <CheckIcon /> : index + 1} {label}
            </Badge>
          </li>)}
        </ol></Flex>
        <form className="hej-form" data-login-step={verified ? 'password' : sent ? 'code' : 'email'}
          onSubmit={(event) => {
            event.preventDefault(); if (verified) {
              login();
            } else if (sent) {
              verify();
            } else {
              send();
            }
          }}>
          <Flex direction="column" gap="4">
            <Box>
              <Text as="label" htmlFor="identifier" size="2" weight="medium">{app.t('이메일', 'Email')}</Text>
              <Flex gap="2" mt="2" className="login-email-row">
                <TextField.Root id="identifier" value={identifier} onChange={(event) => changeIdentifier(event.target.value)}
                  type="text" inputMode="email" autoComplete="username" placeholder="you@example.com" disabled={app.busy} size="3" style={{ flex: 1 }}>
                  <TextField.Slot><EnvelopeClosedIcon /></TextField.Slot>
                </TextField.Root>
                <Button highContrast={!sent} id="sendCode" type="button" size="3" variant={sent ? 'soft' : 'solid'}
                  disabled={busy || !identifier.trim()} onClick={send}>
                  {app.t('인증번호 전송', 'Send code')}
                </Button>
              </Flex>
            </Box>
            <Box hidden={!sent}>
              <Text as="label" htmlFor="authCode" size="2" weight="medium">{app.t('6자리 인증번호 입력', '6-digit code')}</Text>
              <Flex gap="2" mt="2">
                <TextField.Root id="authCode" ref={codeRef} value={authCode} onChange={(event) => setAuthCode(event.target.value)}
                  inputMode="numeric" autoComplete="one-time-code" maxLength={6} disabled={busy || !sent || verified} size="3" style={{ flex: 1 }} />
                <Button highContrast id="verifyCode" type="button" size="3"
                  disabled={busy || !sent || verified || !/^\d{6}$/.test(authCode.trim())} onClick={verify}>
                  {verified ? <CheckIcon /> : null}{app.t('확인', 'Verify')}
                </Button>
              </Flex>
            </Box>
            <Box hidden={!verified}>
              <Text as="label" htmlFor="password" size="2" weight="medium">{app.t('비밀번호', 'Password')}</Text>
              <TextField.Root id="password" ref={passwordRef} value={password} onChange={(event) => setPassword(event.target.value)} type="password"
                autoComplete="current-password" disabled={busy || !verified} size="3" mt="2">
                <TextField.Slot><LockClosedIcon /></TextField.Slot>
              </TextField.Root>
            </Box>
            <Button highContrast id="login" type="submit" size="3" hidden={!verified} disabled={busy || !verified || !password} loading={busy && verified}>
              {app.t('로그인', 'Sign in')}
            </Button>
          </Flex>
        </form>
        <Callout.Root id="loginStatus" role="status" hidden={!message} color="gray"><Callout.Text>{message}</Callout.Text></Callout.Root>
        <Separator size="4" />
        <Text size="2" color="gray">{app.t('로그인 정보는 Homebridge에 보관됩니다. 연결 준비와 Apple Home 페어링 상태는 별도로 확인합니다.',
          'Sign-in is stored on Homebridge. Connection preparation and Apple Home pairing are checked separately.')}</Text>
      </Flex>
    </Card>
  </Box>;
}
