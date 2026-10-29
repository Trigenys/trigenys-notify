import {connect as connectTls,type TLSSocket} from 'node:tls';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';
import type {SmtpSettings,SmtpMessage,SmtpResult} from '../../src/core/email-contracts.js';

type ConnectionOptions=NonNullable<ConstructorParameters<typeof SMTPConnection>[0]>;
type ConnectionFactory=(options:ConnectionOptions,signal?:AbortSignal)=>SMTPConnection|Promise<SMTPConnection>;
/** Workers can reject direct IP sockets after Nodemailer's DNS pre-resolution.
 * Open verified TLS using the configured hostname, then hand the secured socket to SMTP. */
export function createSmtpConnection(options:ConnectionOptions,signal?:AbortSignal):Promise<SMTPConnection>{
  return new Promise((resolve,reject)=>{
    let socket:TLSSocket|undefined,settled=false;
    const failed=(error:unknown)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      signal?.removeEventListener('abort',abort);socket?.destroy();reject(error);
    };
    const abort=()=>{socket?.destroy();failed(new Error('SMTP_CONNECTION_ABORTED'));};
    const timer=setTimeout(()=>failed(Object.assign(new Error('SMTP_CONNECTION_TIMEOUT'),{code:'ETIMEDOUT'})),options.connectionTimeout||2000);
    try{
      socket=connectTls({...options.tls,host:options.host,port:Number(options.port||465),
        servername:options.tls?.servername||options.host,rejectUnauthorized:true,minVersion:'TLSv1.2'});
      socket.once('error',failed);
      socket.once('close',()=>{signal?.removeEventListener('abort',abort);failed(new Error('SMTP_CONNECTION_CLOSED'));});
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      socket.once('secureConnect',()=>{
        if(settled)return;settled=true;clearTimeout(timer);
        resolve(new SMTPConnection({...options,connection:socket,secured:true}));
      });
    }catch(error){failed(error);}
  });
}
/** The provider adapter is centralized here; products never receive SMTP credentials. */
export async function sendSmtpEmail(settings:SmtpSettings,message:SmtpMessage,
  factory:ConnectionFactory=createSmtpConnection):Promise<SmtpResult>{
  let connection:SMTPConnection|undefined,phase:'connect'|'login'|'data'='connect';
  return new Promise<SmtpResult>(resolve=>{
    let settled=false;const controller=new AbortController();
    const finish=(result:SmtpResult)=>{if(settled)return;settled=true;clearTimeout(timer);try{connection?.close();}catch{}controller.abort();resolve(result);};
    const diagnostic=(error:unknown,deadline=false)=>{
      const record=error&&typeof error==='object'?error as {code?:unknown;originalCode?:unknown;responseCode?:unknown;message?:unknown}:{};
      const status=Number(record.responseCode),smtpStatus=Number.isInteger(status)&&status>=400&&status<=599?status:0;
      const allowed=['EAUTH','ECONNECTION','ECONNREFUSED','ECONNRESET','EDNS','EDATA','EENVELOPE','ESOCKET','ETIMEDOUT','ETLS','ENOTFOUND','EAI_AGAIN','ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','EPERM','EACCES','ENETUNREACH','EHOSTUNREACH','ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE','ERR_SSL_WRONG_VERSION_NUMBER','ERR_TLS_INVALID_PROTOCOL_VERSION','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_NOT_IMPLEMENTED'];
      const code=typeof record.code==='string'&&allowed.includes(record.code)?record.code:'UNKNOWN';
      const originalCode=typeof record.originalCode==='string'&&allowed.includes(record.originalCode)?record.originalCode:'UNKNOWN';
      const unsupported=typeof record.message==='string'&&/not implemented|not supported|unsupported/i.test(record.message);
      const reason=deadline?'deadline':code==='EAUTH'||smtpStatus===535?'authentication':unsupported?'runtime_unsupported':smtpStatus?'provider_rejection':'connection';
      // Raw SMTP errors can contain credentials, recipients and bearer links. Emit fixed labels only.
      console.warn(JSON.stringify({event:'notify_smtp_failed',phase,code,smtpStatus,reason,originalCode}));
      return smtpStatus;
    };
    // Includes composition, DNS, TLS, greeting, authentication and SMTP acceptance.
    const timer=setTimeout(()=>{if(settled)return;diagnostic(undefined,true);finish({accepted:false,safeToRetry:phase!=='data'});},4500);
    const failed=(error:unknown)=>{
      if(settled)return;
      const status=diagnostic(error);
      // A disconnected DATA transaction may have been accepted. Never blindly resend it.
      finish({accepted:false,safeToRetry:phase!=='data'||status>=400&&status<=599});
    };
    void (async()=>{
      try{
        const body=await new MailComposer({from:message.from,to:message.recipient,subject:message.subject,
          html:message.html,text:message.text,messageId:message.messageId,date:new Date(message.date),
          disableFileAccess:true,disableUrlAccess:true}).compile().build();
        if(settled)return;
        const opened=await factory({host:settings.host,port:settings.port,secure:true,name:'trigenys.com',
          tls:{servername:settings.host,rejectUnauthorized:true,minVersion:'TLSv1.2'},
          connectionTimeout:2000,greetingTimeout:2000,dnsTimeout:1500,socketTimeout:2500,
          logger:false,debug:false,transactionLog:false},controller.signal);
        if(settled){opened.close();return;}connection=opened;
        connection.on('error',failed);
        connection.on('end',()=>{if(!settled)failed(new Error('SMTP_CLOSED'));});
        connection.connect(error=>{
          if(settled)return;if(error){failed(error);return;}phase='login';
          connection!.login({user:settings.user,pass:settings.password},error=>{
            if(settled)return;if(error){failed(error);return;}phase='data';
            const from=message.from.match(/<([^<>]+)>$/)?.[1];
            if(!from){finish({accepted:false,safeToRetry:true});return;}
            connection!.send({from,to:[message.recipient]},body,(error,info)=>{
              if(settled)return;if(error){failed(error);return;}
              if(info?.accepted?.length===1&&info.rejected?.length===0)finish({accepted:true});
              else finish({accepted:false,safeToRetry:false});
            });
          });
        });
      }catch(error){failed(error);}
    })();
  });
}
