#!/usr/bin/env bash
set -euo pipefail

# Creates the small AWS footprint used by this project: one EC2 instance and
# one private, Single-AZ PostgreSQL RDS instance. Networking is limited to the
# default VPC, two security groups, and a DB subnet group.

command -v aws >/dev/null || { echo "aws CLI is required." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }

aws_region="${AWS_REGION:-eu-north-1}"
app_name="${APP_NAME:-logistics-management}"
key_name="${EC2_KEY_NAME:?Set EC2_KEY_NAME to an existing EC2 key pair name.}"
admin_cidr="${ADMIN_CIDR:-}"
db_identifier="${RDS_INSTANCE_ID:-logistics-postgres}"
db_name="${RDS_DATABASE_NAME:-logistics}"
db_master_user="${RDS_MASTER_USER:-postgres}"
db_instance_class="${RDS_INSTANCE_CLASS:-db.t3.micro}"
ec2_instance_type="${EC2_INSTANCE_TYPE:-t3.micro}"

export AWS_REGION="$aws_region"

vpc_id="$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
[[ "$vpc_id" != "None" && -n "$vpc_id" ]] || {
  echo "No default VPC exists in $aws_region." >&2
  exit 1
}
subnet_ids=($(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$vpc_id" \
  --query 'Subnets[].[SubnetId,AvailabilityZone]' --output text |
  awk '!seen[$2]++ {print $1}'))
[[ ${#subnet_ids[@]} -ge 2 ]] || {
  echo "RDS requires subnets in at least two Availability Zones." >&2
  exit 1
}

find_sg() {
  aws ec2 describe-security-groups \
    --filters "Name=vpc-id,Values=$vpc_id" "Name=group-name,Values=$1" \
    --query 'SecurityGroups[0].GroupId' --output text
}

ec2_sg_name="$app_name-ec2-sg"
rds_sg_name="$app_name-rds-sg"
ec2_sg_id="$(find_sg "$ec2_sg_name")"
if [[ "$ec2_sg_id" == "None" ]]; then
  ec2_sg_id="$(aws ec2 create-security-group --vpc-id "$vpc_id" \
    --group-name "$ec2_sg_name" --description "$app_name web tier" \
    --query GroupId --output text)"
fi
rds_sg_id="$(find_sg "$rds_sg_name")"
if [[ "$rds_sg_id" == "None" ]]; then
  rds_sg_id="$(aws ec2 create-security-group --vpc-id "$vpc_id" \
    --group-name "$rds_sg_name" --description "$app_name database tier" \
    --query GroupId --output text)"
fi

authorize_cidr() {
  aws ec2 authorize-security-group-ingress --group-id "$1" --protocol tcp \
    --port "$2" --cidr "$3" >/dev/null 2>&1 || true
}
authorize_cidr "$ec2_sg_id" 80 0.0.0.0/0
authorize_cidr "$ec2_sg_id" 443 0.0.0.0/0
if [[ -n "$admin_cidr" ]]; then
  authorize_cidr "$ec2_sg_id" 22 "$admin_cidr"
fi
aws ec2 authorize-security-group-ingress --group-id "$rds_sg_id" \
  --protocol tcp --port 5432 --source-group "$ec2_sg_id" >/dev/null 2>&1 || true

subnet_group="$app_name-db-subnets"
if ! aws rds describe-db-subnet-groups --db-subnet-group-name "$subnet_group" >/dev/null 2>&1; then
  aws rds create-db-subnet-group --db-subnet-group-name "$subnet_group" \
    --db-subnet-group-description "$app_name RDS subnets" \
    --subnet-ids "${subnet_ids[@]}" >/dev/null
fi

if ! aws rds describe-db-instances --db-instance-identifier "$db_identifier" >/dev/null 2>&1; then
  if [[ -z "${RDS_MASTER_PASSWORD:-}" ]]; then
    read -rsp "New RDS master password: " RDS_MASTER_PASSWORD
    printf '\n'
  fi
  [[ ${#RDS_MASTER_PASSWORD} -ge 12 ]] || {
    echo "RDS_MASTER_PASSWORD must be at least 12 characters." >&2
    exit 1
  }
  aws rds create-db-instance \
    --db-instance-identifier "$db_identifier" \
    --engine postgres \
    --db-instance-class "$db_instance_class" \
    --allocated-storage 20 \
    --storage-type gp3 \
    --storage-encrypted \
    --no-multi-az \
    --no-publicly-accessible \
    --backup-retention-period 7 \
    --deletion-protection \
    --db-name "$db_name" \
    --master-username "$db_master_user" \
    --master-user-password "$RDS_MASTER_PASSWORD" \
    --vpc-security-group-ids "$rds_sg_id" \
    --db-subnet-group-name "$subnet_group" \
    --tags Key=Application,Value="$app_name" Key=Environment,Value=production >/dev/null
else
  db_status="$(aws rds describe-db-instances --db-instance-identifier "$db_identifier" --query 'DBInstances[0].DBInstanceStatus' --output text)"
  if [[ "$db_status" == "stopped" ]]; then
    aws rds start-db-instance --db-instance-identifier "$db_identifier" >/dev/null
  fi
fi
unset RDS_MASTER_PASSWORD

role_name="$app_name-ec2-role"
profile_name="$app_name-ec2-profile"
trust_document='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  aws iam create-role --role-name "$role_name" \
    --assume-role-policy-document "$trust_document" >/dev/null
fi
aws iam attach-role-policy --role-name "$role_name" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
if ! aws iam get-instance-profile --instance-profile-name "$profile_name" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$profile_name" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$profile_name" \
    --role-name "$role_name"
  sleep 10
fi

instance_id="$(aws ec2 describe-instances \
  --filters "Name=tag:Application,Values=$app_name" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"
if [[ "$instance_id" == "None" ]]; then
  ami_id="$(aws ec2 describe-images --owners 099720109477 \
    --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
      'Name=architecture,Values=x86_64' 'Name=state,Values=available' \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
  instance_id="$(aws ec2 run-instances --image-id "$ami_id" \
    --instance-type "$ec2_instance_type" --key-name "$key_name" \
    --security-group-ids "$ec2_sg_id" \
    --iam-instance-profile Name="$profile_name" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$app_name},{Key=Application,Value=$app_name},{Key=Environment,Value=production}]" \
    --query 'Instances[0].InstanceId' --output text)"
fi

instance_state="$(aws ec2 describe-instances --instance-ids "$instance_id" --query 'Reservations[0].Instances[0].State.Name' --output text)"
if [[ "$instance_state" == "stopped" ]]; then
  aws ec2 start-instances --instance-ids "$instance_id" >/dev/null
fi

aws ec2 wait instance-running --instance-ids "$instance_id"
aws rds wait db-instance-available --db-instance-identifier "$db_identifier"
public_ip="$(aws ec2 describe-instances --instance-ids "$instance_id" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
public_dns="$(aws ec2 describe-instances --instance-ids "$instance_id" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)"
rds_endpoint="$(aws rds describe-db-instances --db-instance-identifier "$db_identifier" --query 'DBInstances[0].Endpoint.Address' --output text)"

printf 'EC2 instance: %s\nPublic IP: %s\nPublic DNS: %s\nRDS endpoint: %s\n' \
  "$instance_id" "$public_ip" "$public_dns" "$rds_endpoint"
printf 'Next: SSH or use Session Manager, then run scripts/setup-aws-instance.sh.\n'
