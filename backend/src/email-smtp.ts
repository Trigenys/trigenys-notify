import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';
import type {SmtpSettings,SmtpMessage,SmtpResult} from '../../src/core/email-contracts.js';

type ConnectionFactory=(options:ConstructorParameters<typeof SMTPConnection>[0])=>SMTPConnection;
/** The provider adapter is centralized here; products never receive SMTP credentials. */
export async function sendSmtpEmail(settings:SmtpSettings,message:SmtpMessage,
  factory:ConnectionFactory=options=>new SMTPConnection(options)):Promise<SmtpResult>{
  let connection:SMTPConnection|undefined,phase:'connect'|'login'|'data'='connect';
  return new Promise<SmtpResult>(resolve=>{
    let settled=false;
    const finish=(result:SmtpResult)=>{if(settled)return;settled=true;clearTimeout(timer);try{connection?.close();}catch{}resolve(result);};
    // Includes composition, DNS, TLS, greeting, authentication and SMTP acceptance.
    const timer=setTimeout(()=>finish({accepted:false,safeToRetry:phase!=='data'}),4500);
    const failed=(error:unknown)=>{
      const status=error&&typeof error==='object'&&'responseCode' in error?Number(error.responseCode):0;
      // A disconnected DATA transaction may have been accepted. Never blindly resend it.
      finish({accepted:false,safeToRetry:phase!=='data'||status>=400&&status<=599});
    };
    void (async()=>{
      try{
        const body=await new MailComposer({from:message.from,to:message.recipient,subject:message.subject,
          html:message.html,text:message.text,messageId:message.messageId,date:new Date(message.date),
          disableFileAccess:true,disableUrlAccess:true}).compile().build();
        if(settled)return;
        connection=factory({host:settings.host,port:settings.port,secure:true,name:'trigenys.com',
          tls:{servername:settings.host,rejectUnauthorized:true,minVersion:'TLSv1.2'},
          connectionTimeout:2000,greetingTimeout:2000,dnsTimeout:1500,socketTimeout:2500,
          logger:false,debug:false,transactionLog:false});
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
